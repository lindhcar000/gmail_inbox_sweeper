# Inbox Sweep

A website that cleans up Gmail. It finds marketing email, social media notifications, website notifications and mail you never opened. You review everything, then send it to Trash with one click.

**It runs entirely in your browser.** Your browser talks directly to Google's Gmail API. There is no server, so there's nothing to host except the files themselves, and no email data ever leaves your computer.

## What's in this folder
| File | What it is |
|---|---|
| `index.html` | The page and its styles |
| `app.js` | Google sign-in, scanning, the review table, trashing |
| `rules.js` | The deletion rules (what counts as marketing, what's protected) |
| `config.js` | **Your Google Client ID goes here** |
| `privacy.html` | Privacy policy. Google needs one if you ever publish the app. Replace `YOUR_EMAIL_HERE` with your email. |
| `test/rules.test.js` | Tests for the rules. Run them with `node test/rules.test.js`. |

## Setup (about 15 minutes)

### 1. Put the site on GitHub Pages
1. Create a new public repository on GitHub, for example `inbox-sweep`.
2. Upload all of these files to it, keeping the `test` folder.
3. Go to **Settings → Pages**. Under "Build and deployment", choose **Deploy from a branch**, select `main` and `/ (root)`, then click **Save**.
4. After a minute, your site is live at `https://YOUR-USERNAME.github.io/inbox-sweep/`.

### 2. Connect it to Google
1. Go to https://console.cloud.google.com and create a project, for example "Inbox Sweep".
2. Go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (also called "Google Auth Platform → Branding/Audience"):
   - User type: **External**
   - App name: Inbox Sweep. Add your email as the support and developer contact.
   - Under **Audience → Test users**, add your Gmail address, plus any friends who'll use it (up to 100).
4. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Under **Authorized JavaScript origins**, add `https://YOUR-USERNAME.github.io`. That's just the domain, with no `/inbox-sweep` and no trailing slash. Also add `http://localhost:8000` if you want to test on your own computer.
   - Click **Create** and copy the Client ID. It ends in `.apps.googleusercontent.com`.
5. Paste the Client ID into `config.js` and commit the change. A Client ID is meant to be public, so it's safe to put on GitHub.

### 3. Use it
Open your site, click **Sign in with Google**, choose your rules and click **Scan my inbox**. Review the "To trash" list:
- Untick anything you want to keep.
- Click **Always keep** to protect a sender forever.
- Click **Unsubscribe** (twice, to confirm) to stop a sender from mailing you. It uses the sender's own unsubscribe option from the email's `List-Unsubscribe` header: a one-click request if they support it, otherwise an unsubscribe email from your Gmail, otherwise their unsubscribe page in a new tab.

Then click **Move selected to Trash** (it asks you to click twice). You can recover trashed email from Gmail's Trash for 30 days.

Because the app is in Google's "Testing" mode, you'll see a "Google hasn't verified this app" screen. Click **Continue**. Sign-ins also expire after about an hour, and the app asks you to sign in again when that happens.

## Testing on your own computer
```
python3 -m http.server 8000
```
Then open http://localhost:8000. Opening `index.html` directly as a file won't work, because Google sign-in needs a web address.

## What users can customize
- Turn each rule on or off: marketing, social media, website notifications, and unopened old mail
- Choose how old unopened mail must be before it's deleted: a slider from 1 month to 10 years (default 1 year), or an exact date
- Marketing strictness, from Aggressive to "Only obvious ads"
- A keep list of senders or domains that are never deleted
- Extra social media domains
- How many emails to scan per rule

Settings are saved in each user's own browser.

## Always protected
- Conversations you replied to
- Personal email sent only to you
- Starred email
- Receipts, bills, statements and security alerts
- Job-application updates
- Everyone on your keep list

## Opening it to the public later
In Testing mode, only the people you add as test users can sign in, up to 100. To let anyone use it, submit the app for verification under **OAuth consent screen → Publish app**. Google will ask for:
- the privacy policy (`privacy.html`)
- a homepage, ideally on a domain you own
- a demo video
- a justification for the `gmail.modify` scope

Because Gmail access is a "restricted" scope, Google may also require a security assessment. This app has no server, which is the strongest position to be in for that review.
