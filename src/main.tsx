import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { isFirebaseConfigured } from './firebase.ts';
import { isApiBaseConfigured } from './utils/api.ts';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import './index.css';

const requiresApiOrigin =
  import.meta.env.PROD &&
  window.location.hostname.endsWith('vercel.app') &&
  !isApiBaseConfigured;
const needsConfiguration = !isFirebaseConfigured || requiresApiOrigin;

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {!needsConfiguration ? (
      <App />
    ) : (
      <main
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px',
          background: '#0b1220',
          color: '#e8eef8',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <section style={{ maxWidth: '640px', width: '100%' }}>
          <p style={{ color: '#8bdcff', fontWeight: 700, letterSpacing: '0.12em' }}>
            DOWNLYX · CONFIGURATION REQUIRED
          </p>
          <h1 style={{ fontSize: 'clamp(2rem, 6vw, 3rem)', marginBottom: '12px' }}>
            Production configuration is incomplete
          </h1>
          <p style={{ lineHeight: 1.7, color: '#b8c5d8' }}>
            { !isFirebaseConfigured
              ? 'The app is paused because the Firebase web API key is missing.'
              : 'The app is paused because the Vercel frontend has no API origin configured.' }
            Authentication and downloads cannot work until the deployment settings are complete.
          </p>
          <ol style={{ lineHeight: 1.9, color: '#d5deec', paddingLeft: '22px' }}>
            {!isFirebaseConfigured && <>
              <li>Open Firebase Console → Project settings → General → Your apps and copy the Web API key.</li>
              <li>Add <code>VITE_FIREBASE_API_KEY</code> to Vercel’s Production environment variables.</li>
            </>}
            {requiresApiOrigin && <>
              <li>Deploy the Express API and FFmpeg runtime to a persistent container host.</li>
              <li>Add <code>VITE_API_BASE_URL</code> to Vercel with the API origin (for example, <code>https://api.example.com</code>).</li>
              <li>Configure the API’s <code>DOWNLYX_ALLOWED_ORIGINS</code> with this frontend’s exact origin.</li>
            </>}
            <li>Redeploy the production build.</li>
          </ol>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
            Never put Firebase Admin credentials or service-account JSON in a
            VITE_ variable. Restrict the Firebase web API key using API-key
            settings and authorized domains.
          </p>
        </section>
      </main>
    )}
  </ErrorBoundary>
);
