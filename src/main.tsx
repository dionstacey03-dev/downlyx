import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { isFirebaseConfigured } from './firebase.ts';
import {ErrorBoundary} from './components/ErrorBoundary.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    {isFirebaseConfigured ? (
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
            Firebase is not configured
          </h1>
          <p style={{ lineHeight: 1.7, color: '#b8c5d8' }}>
            The app is safely paused because its Firebase web API key is missing.
            Authentication and user data cannot work until the project owner adds
            the key. This is a deployment configuration issue, not a sign-in problem.
          </p>
          <ol style={{ lineHeight: 1.9, color: '#d5deec', paddingLeft: '22px' }}>
            <li>Open the Firebase console and select the DOWNLYX project.</li>
            <li>Go to Project settings → General → Your apps and copy the Web API key.</li>
            <li>
              Add <code>VITE_FIREBASE_API_KEY</code> to the Vercel project’s
              Production environment variables.
            </li>
            <li>Redeploy the production build.</li>
          </ol>
          <p style={{ color: '#94a3b8', fontSize: '0.9rem' }}>
            Do not put Firebase Admin credentials or service-account JSON in this
            frontend variable. The web API key is a client identifier; restrict
            it using Firebase/API key settings and authorized domains.
          </p>
        </section>
      </main>
    )}
);
