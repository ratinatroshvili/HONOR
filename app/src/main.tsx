import { Buffer } from "buffer";
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/instrument-sans";
import "@fontsource/cinzel/600.css";
import "@fontsource/cinzel/800.css";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import { App } from "./App";
import { CLUSTER, RPC_URL } from "./honor";
import { DemoWalletAdapter } from "./demoWallet";

function Root() {
  // Phantom, Solflare, Backpack etc. are detected automatically (Wallet Standard).
  // On test networks a built-in demo wallet is offered too, so anyone can try HONOR without installing anything.
  const wallets = useMemo(() => (CLUSTER === "mainnet-beta" ? [] : [new DemoWalletAdapter()]), []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
