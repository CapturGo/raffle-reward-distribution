import React from 'react';
import ReactDOM from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { App } from './App';
import './styles.css';

const privyAppId = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined) || 'cmj5wppqx00y8jo0cl794vgbz';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ['email'],
        appearance: {
          theme: 'light',
          accentColor: '#155EEF',
          logo: undefined,
        },
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
