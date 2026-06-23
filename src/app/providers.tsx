'use client';

import { PrivyProvider } from '@privy-io/react-auth';

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? 'cmj5wppqx00y8jo0cl794vgbz';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={privyAppId}
      config={{
        loginMethods: ['email'],
        appearance: { theme: 'light', accentColor: '#155EEF' },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
