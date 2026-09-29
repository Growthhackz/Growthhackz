import { UpstreamError } from '../lib/errors.js';
import { jsonFetch } from '../lib/http.js';
import { nowMs, type ServiceContext } from '../services/context.js';

/**
 * Finds the X post to raid from a profile URL, with no account or paid API: the same logged-out (guest) endpoints
 * x.com's own web client uses. The pinned post wins; otherwise the best-performing recent original post; otherwise
 * the latest original post. Query IDs and the web bearer change occasionally, so they are configurable.
 */

const HOUR = 3_600_000;
const RECENT_MS = 14 * 24 * HOUR;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const RESERVED = new Set(['home', 'i', 'intent', 'search', 'explore', 'share', 'hashtag', 'settings', 'messages', 'notifications']);

export interface RaidPost {
  url: string;
  source: 'pinned' | 'top_recent' | 'latest';
  tweet_id: string;
}

/** `https://x.com/<handle>` (or twitter.com, with or without www/mobile) → handle; anything else → null. */
export function handleFromProfileUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !/^(www\.|mobile\.)?(x|twitter)\.com$/.test(u.hostname)) return null;
    const [first, second] = u.pathname.split('/').filter(Boolean);
    if (!first || second || !HANDLE.test(first) || RESERVED.has(first.toLowerCase())) return null;
    return first;
  } catch {
    return null;
  }
}

/** X answers 404 to requests without a browser-like user agent. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

let guest: { token: string; at: number } | null = null;

async function guestToken(ctx: ServiceContext, fresh = false): Promise<string> {
  if (!fresh && guest && nowMs(ctx) - guest.at < 2 * HOUR) return guest.token;
  const r = await jsonFetch(ctx.http, 'https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: { authorization: `Bearer ${ctx.config.X_WEB_BEARER}`, 'user-agent': UA },
  });
  if (typeof r?.guest_token !== 'string' || !/^\d+$/.test(r.guest_token)) throw new UpstreamError('X did not issue a guest token');
  guest = { token: r.guest_token, at: nowMs(ctx) };
  return guest.token;
}

async function gql(ctx: ServiceContext, queryId: string, op: string, variables: object, features: object): Promise<any> {
  const url = new URL(`https://api.x.com/graphql/${queryId}/${op}`);
  url.searchParams.set('variables', JSON.stringify(variables));
  url.searchParams.set('features', JSON.stringify(features));
  const get = async (fresh: boolean) =>
    jsonFetch(ctx.http, url.href, {
      headers: { authorization: `Bearer ${ctx.config.X_WEB_BEARER}`, 'x-guest-token': await guestToken(ctx, fresh), 'user-agent': UA },
    });
  try {
    return await get(false);
  } catch {
    // Guest tokens expire or get rate-limited; one retry with a new one.
    return get(true);
  }
}

const USER_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  rweb_tipjar_consumption_enabled: true,
};

const TWEET_FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** Every tweet object in a UserTweets response, wherever it sits in the timeline. */
function timelineTweets(res: any): any[] {
  const out: any[] = [];
  const visit = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (v.__typename === 'Tweet' && v.legacy && v.rest_id) out.push(v);
    else if (v.__typename === 'TweetWithVisibilityResults' && v.tweet) return visit(v.tweet);
    for (const k of Object.keys(v)) if (k !== 'quoted_status_result' && k !== 'retweeted_status_result') visit(v[k]);
  };
  visit(res?.data?.user?.result?.timeline);
  return out;
}

const postUrl = (handle: string, id: string) => `https://x.com/${handle}/status/${id}`;

/** Returns the post to raid, or null when the account has none (missing, suspended, protected or empty). */
export async function findRaidPost(ctx: ServiceContext, profileUrl: string | undefined): Promise<RaidPost | null> {
  const handle = handleFromProfileUrl(profileUrl);
  if (!handle) return null;
  const u = await gql(ctx, ctx.config.X_GQL_USER_BY_SCREEN_NAME, 'UserByScreenName', { screen_name: handle }, USER_FEATURES);
  const user = u?.data?.user?.result;
  if (!user || user.__typename !== 'User' || !user.rest_id || user.legacy?.protected) return null;
  const screen = HANDLE.test(user.legacy?.screen_name ?? '') ? user.legacy.screen_name : handle;

  const pinned = user.legacy?.pinned_tweet_ids_str?.[0];
  if (typeof pinned === 'string' && /^\d{1,25}$/.test(pinned)) return { url: postUrl(screen, pinned), source: 'pinned', tweet_id: pinned };

  const t = await gql(
    ctx,
    ctx.config.X_GQL_USER_TWEETS,
    'UserTweets',
    { userId: user.rest_id, count: 40, includePromotedContent: false, withVoice: true },
    TWEET_FEATURES,
  );
  const own = timelineTweets(t).filter(
    (x) =>
      x.legacy.user_id_str === user.rest_id &&
      !x.legacy.retweeted_status_result &&
      !x.legacy.in_reply_to_status_id_str &&
      /^\d{1,25}$/.test(x.rest_id),
  );
  if (!own.length) return null;
  const at = (x: any) => Date.parse(x.legacy.created_at) || 0;
  const score = (x: any) => (x.legacy.favorite_count ?? 0) + 2 * (x.legacy.retweet_count ?? 0) + (x.legacy.reply_count ?? 0);
  const recent = own.filter((x) => nowMs(ctx) - at(x) <= RECENT_MS);
  if (recent.length) {
    const top = recent.sort((a, b) => score(b) - score(a) || at(b) - at(a))[0];
    return { url: postUrl(screen, top.rest_id), source: 'top_recent', tweet_id: top.rest_id };
  }
  const latest = own.sort((a, b) => at(b) - at(a))[0];
  return { url: postUrl(screen, latest.rest_id), source: 'latest', tweet_id: latest.rest_id };
}
