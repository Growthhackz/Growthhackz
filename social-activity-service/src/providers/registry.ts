import type { Config } from '../config.js';
import { FollowizClient, type ProviderCallRecorder } from './followiz/client.js';
import { FollowizProvider } from './followiz/provider.js';
import { MockProvider } from './mock/provider.js';
import type { SocialProvider } from './types.js';

export function createProvider(config: Config, recorder?: ProviderCallRecorder): SocialProvider {
  switch (config.PROVIDER) {
    case 'followiz':
      return new FollowizProvider(
        new FollowizClient({
          apiUrl: config.FOLLOWIZ_API_URL,
          apiKey: config.FOLLOWIZ_API_KEY!,
          timeoutMs: config.PROVIDER_TIMEOUT_MS,
          minIntervalMs: config.PROVIDER_MIN_INTERVAL_MS,
          recorder,
        }),
      );
    case 'mock':
      return new MockProvider();
  }
}
