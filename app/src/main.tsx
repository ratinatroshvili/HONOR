import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import React from "react";
import ReactDOM from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { ConnectionProvider } from "@solana/wallet-adapter-react";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/800.css";
import "./styles.css";
import { App } from "./App";
import { RPC_URL } from "./honor";
import { PRIVY_APP_ID } from "./login";

const WS_URL = RPC_URL.replace(/^http/, "ws");

function Root() {
  if (!PRIVY_APP_ID)
    return (
      <p style={{ padding: 32, color: "#f4efff", background: "#0d0820", fontFamily: "system-ui" }}>
        Missing VITE_PRIVY_APP_ID. Add your Privy App ID to app/.env (or Netlify's environment variables) and rebuild.
      </p>
    );
  // Players log in with Google only. Privy creates a Solana wallet for each of them behind the
  // scenes and signs game actions silently; nobody ever sees a wallet.
  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["google"],
        appearance: {
          theme: "dark",
          accentColor: "#7c3aed",
          logo: `${window.location.origin}/honor-logo.png`,
          landingHeader: "Enter the hall",
          loginMessage: "Sign in with Google to play HONOR.",
          walletChainType: "solana-only",
        },
        embeddedWallets: {
          solana: { createOnLogin: "all-users" },
          ethereum: { createOnLogin: "off" },
          showWalletUIs: false,
        },
        solana: {
          rpcs: {
            "solana:devnet": { rpc: createSolanaRpc(RPC_URL), rpcSubscriptions: createSolanaRpcSubscriptions(WS_URL) },
          },
        },
      }}
    >
      <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
        <App />
      </ConnectionProvider>
    </PrivyProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
