# Signal Loft

One room. Infinite jobs. Every action has a consequence — forever.

Mobile hacker life-sim: live in a single loft, dive into a desktop OS, buy gear from the store or a shady darknet, and watch choices rewrite the continuum without an ending.

## Brand

| | |
|---|---|
| **Name** | Signal Loft |
| **Bundle ID** | `app.signalloft.game` |
| **Icon** | `resources/icon-1024.png` / `www/assets/icon-512.png` |
| **Wordmark** | `www/assets/wordmark.jpg` |

## Play in browser

```bash
npm install
npm run build
npx --yes serve www -p 8765
```

Open the site on your phone, or use the Capacitor iOS wrapper below.

## Unsigned IPA via GitHub Actions

Push to `main` / `cursor/**` or run **Actions → Build Unsigned IPA → Run workflow**.

The macOS job:

1. Builds the web game  
2. `cap add ios` + `cap sync`  
3. `xcodebuild` with signing disabled  
4. Zips `Payload/*.app` into **`SignalLoft-unsigned.ipa`**  
5. Uploads it as a workflow artifact  

Download the artifact from the successful run. Unsigned IPAs need sideloading / resigning (AltStore, TrollStore, your own cert, etc.) — they will not install from the App Store.

## Local Capacitor (Mac)

```bash
npm install
npm run build
npx cap add ios   # once
npx cap sync ios
npx cap open ios
```

## Loop (design)

- Single loft that upgrades as you buy gear  
- Desktop UI: Inbox · Jobs · Store · Darknet · Continuum  
- Equipment gates jobs  
- Darknet: mythic loot, crypto drift, variable scams  
- Story choices never end the game — they only spawn the next pressure  
