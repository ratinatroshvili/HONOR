// A test-network-only wallet that lives in this browser, so people can try HONOR without
// installing Phantom. Unlike the stock "Burner" wallet, it remembers its key across refreshes.
// Never use it for anything of value: the key sits in localStorage.
import type { WalletName } from "@solana/wallet-adapter-base";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { Keypair } from "@solana/web3.js";

const KEY = "honor:demo-wallet";

function loadOrCreate(): Keypair {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved)));
  } catch {
    /* fall through */
  }
  const kp = Keypair.generate();
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(kp.secretKey)));
  } catch {
    /* private mode: key lasts for this tab only */
  }
  return kp;
}

export class DemoWalletAdapter extends UnsafeBurnerWalletAdapter {
  // The base class types its name as "Burner Wallet"; we rename it for people using the app.
  name = "Demo Wallet" as unknown as WalletName<"Burner Wallet">;

  async connect(): Promise<void> {
    const kp = loadOrCreate();
    (this as unknown as { _keypair: Keypair })._keypair = kp;
    this.emit("connect", kp.publicKey);
  }
}
