import { google } from 'googleapis';
import { createGoogleDriveApiAdapter } from './drive-uploader.js';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export function createGoogleOAuthManager(repos) {
    function buildOAuthClient(redirectUri) {
        const s = repos.settings.get();
        if (!s.googleClientId || !s.googleClientSecret) {
            throw new Error('Google OAuth Client ID dan Client Secret belum diisi di menu Pengaturan.');
        }
        const client = new google.auth.OAuth2(s.googleClientId, s.googleClientSecret, redirectUri);
        if (s.googleTokens) {
            client.setCredentials(s.googleTokens);
        }
        client.on('tokens', (newTokens) => {
            const latest = repos.settings.get();
            repos.settings.update({
                googleTokens: {
                    ...latest.googleTokens,
                    ...newTokens,
                },
            });
        });
        return client;
    }
    return {
        getAuthUrl(redirectUri) {
            const client = buildOAuthClient(redirectUri);
            return client.generateAuthUrl({
                access_type: 'offline',
                prompt: 'consent',
                scope: [DRIVE_FILE_SCOPE],
            });
        },
        async handleCallback(code, redirectUri) {
            const client = buildOAuthClient(redirectUri);
            const { tokens } = await client.getToken(code);
            client.setCredentials(tokens);
            const latest = repos.settings.get();
            const mergedTokens = {
                ...latest.googleTokens,
                ...tokens,
            };
            const drive = google.drive({ version: 'v3', auth: client });
            let email = null;
            try {
                const about = await drive.about.get({ fields: 'user(emailAddress)' });
                email = about.data.user?.emailAddress ?? null;
            }
            catch {
                // non-fatal
            }
            repos.settings.update({
                googleTokens: mergedTokens,
                googleAccountEmail: email,
            });
            return { email };
        },
        disconnect() {
            repos.settings.update({
                googleTokens: null,
                googleAccountEmail: null,
            });
        },
        isConnected() {
            const s = repos.settings.get();
            return Boolean(s.googleClientId &&
                s.googleClientSecret &&
                (s.googleTokens?.refresh_token || s.googleTokens?.access_token));
        },
        getAuthenticatedDriveRaw() {
            if (!this.isConnected())
                return null;
            const client = buildOAuthClient();
            return google.drive({ version: 'v3', auth: client });
        },
        async getDriveApiAdapter() {
            const raw = this.getAuthenticatedDriveRaw();
            if (!raw)
                return null;
            return createGoogleDriveApiAdapter(raw);
        },
    };
}
