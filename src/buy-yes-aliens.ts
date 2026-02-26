import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { ethers } from "ethers";

const PROXY_URL = process.env.PROXY_URL!;
const RPC_URL = process.env.RPC_URL!;
const PK = process.env.EVM_PRIVATE_KEY!;

const YES_TOKEN = "107505882767731489358349912513945399560393482969656700824895970500493757150417";
const USDC_E = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // bridged
const USDC   = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"; // native

const BUY_AMOUNT = parseFloat(process.env.BUY_AMOUNT || "150");
const DRY_RUN = process.env.DRY_RUN === "1";

async function getUsdcBalance(contract: ethers.Contract, wallet: string): Promise<number> {
  const bal = await contract.balanceOf(wallet);
  return parseFloat(ethers.utils.formatUnits(bal, 6));
}

async function main() {
  if (!PK) { console.error("EVM_PRIVATE_KEY not set"); process.exit(1); }
  
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(PK, provider);
  console.log(`Wallet: ${signer.address}`);
  
  const usdcE = new ethers.Contract(USDC_E, ["function balanceOf(address) view returns (uint256)"], provider);
  const usdc  = new ethers.Contract(USDC,   ["function balanceOf(address) view returns (uint256)"], provider);
  
  const [balE, balN] = await Promise.all([
    getUsdcBalance(usdcE, signer.address),
    getUsdcBalance(usdc, signer.address),
  ]);
  
  console.log(`USDC.e: $${balE.toFixed(2)}`);
  console.log(`USDC:   $${balN.toFixed(2)}`);
  
  const totalAvailable = balE + balN;
  
  if (totalAvailable < BUY_AMOUNT) {
    console.log(`\n⚠️  Insufficient funds: $${totalAvailable.toFixed(2)} available, need $${BUY_AMOUNT}`);
    console.log(`Send $${(BUY_AMOUNT - totalAvailable).toFixed(2)} more to: ${signer.address}`);
    process.exit(2); // exit code 2 = needs funding
  }
  
  // Fetch live YES price
  const priceRes = await fetch(`https://gamma-api.polymarket.com/markets/703257`);
  const mkt: any = await priceRes.json();
  const askPrice = parseFloat(mkt.bestAsk || "0.17");
  
  const shares = Math.floor(BUY_AMOUNT / askPrice);
  const actualCost = (shares * askPrice).toFixed(2);
  const potentialReturn = shares;
  const potentialProfit = (shares - parseFloat(actualCost)).toFixed(2);
  
  console.log(`\n📊 Pre-flight`);
  console.log(`  Current ask:    $${askPrice}`);
  console.log(`  Spend:          $${actualCost}`);
  console.log(`  Shares:         ${shares} YES`);
  console.log(`  If YES wins:    $${potentialReturn} (+$${potentialProfit})`);
  console.log(`  If NO wins:     -$${actualCost}`);
  console.log(`  New total pos:  ~${9737 + shares} shares @ ~17¢ avg`);
  
  if (DRY_RUN) {
    console.log("\n[DRY RUN] Order not placed.");
    return;
  }
  
  console.log("\nPlacing order...");
  
  const client = new ClobClient(PROXY_URL, 137, signer);
  const creds = await client.createOrDeriveApiKey();
  if ((creds as any).key && !(creds as any).apiKey) (creds as any).apiKey = (creds as any).key;
  const authed = new ClobClient(PROXY_URL, 137, signer, creds, 0, signer.address);
  
  const order = await authed.createAndPostOrder({
    tokenID: YES_TOKEN,
    price: askPrice,
    side: Side.BUY,
    size: shares,
    orderType: OrderType.GTC,
  });
  
  console.log("\n✅ Order placed:", JSON.stringify(order, null, 2));
}

main().catch(e => {
  console.error("Error:", e.message || e);
  process.exit(1);
});
