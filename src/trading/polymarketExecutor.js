import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "ethers";

const host = "https://clob.polymarket.com";
const chainId = 137;

const wallet = new Wallet(process.env.PRIVATE_KEY); // signer

let client = null;

export async function initPolymarket() {
  const baseClient = new ClobClient(host, chainId, wallet);

  // L1 → gera creds
  const creds = await baseClient.createOrDeriveApiKey();

  client = new ClobClient(
    host,
    chainId,
    wallet,
    creds,
    1, // 👈 CORRETO PRA PRIVATE KEY
    process.env.POLYMARKET_FUNDER // 👈 endereço da polymarket
  );

  console.log("✅ Proxy wallet conectada");
}

export async function executeOrder({ tokenId, price, size, side }) {
  if (!client) throw new Error("Client não inicializado");

    // 🧮 Polymarket opera com "shares", então precisamos converter o valor em USDC para a quantidade de share
    // 🔥 converte USDC → shares
    // Exemplo: se queremos gastar $10 em um token que custa $0.50, isso nos daria 20 shares.
    // Minimo de 5 shares por ordem, então se o valor for muito baixo, ajustamos para 5 shares. Isso ajuda a evitar ordens muito pequenas que podem não ser executadas.
    const MIN_SHARES = 5;

    let shares = size / price;

    if (shares < MIN_SHARES) {
    shares = MIN_SHARES;
    }

    shares = Number(shares.toFixed(6));

  console.log('🚀 Executando ordem:', {
      tokenID: tokenId,
      price,
      size: shares,
      side          
    },
    {
      tickSize: "0.01",
      negRisk: false
    });

  return await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price,
      size: shares, // ✅ aqui sim
      side           // ✅ "BUY"
    },
    {
      tickSize: "0.01",
      negRisk: false
    }
  );
}
