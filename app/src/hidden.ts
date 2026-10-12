// Players hidden from the global leaderboards. Records on Solana can't be deleted, so hiding
// happens here in the app. Add a wallet address (a profile's `authority`) to hide that player.
export const HIDDEN_PLAYERS = new Set<string>([
  "7EhNmzRczdgfqgg3Epveo8BPSMNCcC9RdKvVFZ2cnpXM", // Erekle Vardiashvili
  "2oALGizZZioeJ7oXXkkiS3C3i6fqZBbtSuHSfAMp4pN8", // Rati Beridze
  "8wDXpeQxbauvJ3TQxGi9cmWpYmrFrUKmjichsz4CLJXQ", // toko menabde
  "FnWcKVKhdhoTMqt7j1uTFo1C8hAsFN6SKWPHJ54nGMnk", // Test Player (bank test)
]);
