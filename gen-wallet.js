// Run ONCE on your own computer:  node gen-wallet.js
// Prints a new DigiByte hot wallet. Put the WIF into the DGB_WIF environment variable on Render
// and send DGB to the address. NEVER commit or share the WIF.
const bitcoin = require('bitcoinjs-lib');
const DGB = {
  messagePrefix: '\x19DigiByte Signed Message:\n',
  bech32: 'dgb',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x1e,
  scriptHash: 0x3f,
  wif: 0x80
};
const kp = bitcoin.ECPair.makeRandom({ network: DGB });
const { address } = bitcoin.payments.p2pkh({ pubkey: kp.publicKey, network: DGB });
console.log('Deposit address (send DGB here):', address);
console.log('Private key WIF (SECRET, goes in DGB_WIF):', kp.toWIF());
