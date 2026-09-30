# Reaching the UI from anywhere

The server holds your wallet keys, so it never listens on a public address.
Remote access goes through [Tailscale](https://tailscale.com): a private
network between your own devices. Nobody outside your tailnet can reach the
app, and the password login protects it even from inside.

## 1. Set a password

Pick a password of 12+ characters. It is separate from `WALLET_PASSPHRASE`:
the passphrase decrypts the keys on disk, the password lets a browser in.

## 2. Install Tailscale

- On the computer that runs the app: install Tailscale and sign in.
- On your phone / laptop: install the Tailscale app and sign in to the same account.
- In the Tailscale admin console, under **DNS**, enable **MagicDNS** and
  **HTTPS certificates**.

## 3. Serve the app over HTTPS on your tailnet

On the computer running the app:

```bash
tailscale serve --bg 3000
tailscale serve status        # prints your URL, e.g. https://my-pc.tail1234.ts.net
```

## 4. Start the app with that hostname allowed

```bash
export RPC_URL="https://your-mainnet-rpc"
export WALLET_PASSPHRASE="…"
export RECEIVER_PUBKEY="…"                     # optional
export APP_PASSWORD="a long login password"
export ALLOWED_HOSTS="my-pc.tail1234.ts.net"  # the hostname from step 3
npm start
```

Open `https://my-pc.tail1234.ts.net` on any device signed in to Tailscale, and
sign in with `APP_PASSWORD`. `http://localhost:3000` on the computer itself
keeps working and asks for the same password.

## Notes

- **The app runs on that computer.** Rules only fire while it is on, awake and
  running `npm start`. For always-on, run it on a small VPS instead and install
  Tailscale there the same way.
- Sessions last 7 days and end when the server restarts. 8 wrong passwords
  lock sign-in for 15 minutes.
- Do not use `tailscale funnel` or open port 3000 on your router: both put
  the app on the public internet.
- The server refuses to start with `ALLOWED_HOSTS` or `HOST` set unless
  `APP_PASSWORD` is set.
