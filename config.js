// Public settings. The Google OAuth client ID is NOT a secret (there is no client secret in this flow).
//
// To enable "Sign in with Google" and Drive sync:
//   1. Google Cloud Console -> APIs & Services -> Credentials -> Create credentials -> OAuth client ID
//   2. Application type: Web application
//   3. Authorized JavaScript origins (origin only, no path, no trailing slash):
//        https://mdrdannyr.github.io
//        http://localhost:8000     (and http://localhost, for local testing)
//   4. Paste the client ID below.
//   5. Enable the Google Drive API for the project.
//   6. Create an API key (APIs & Services -> Credentials) and paste it below.
//      The API key is required by the Google Picker so collaborators can open a shared data file.
//      Restrict it to your HTTP referrers and to the Google Picker API.
window.APP_CONFIG = {
  googleClientId: "1018863696965-np77av63b1l6hdfk63t2h0lkmnnelte9.apps.googleusercontent.com",
  googleDriveApiKey: "AIzaSyBav-jQflfQ8mHj0uJQbRywUebqvQpGIn8",
  driveFolderName: "PWA Demo",
  driveFileName: "data.json"
};
