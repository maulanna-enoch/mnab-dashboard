// last-4-digits (of the card, or of the account number when there's no
// card involved) → exact Accounts.Name. Confirmed with the user — use
// verbatim, don't reformat.
var MANDIRI_SOF_MAP = {
  '2166': 'mandiri platinum',
  '2892': 'mandiri 2892',
  '2069': 'mandiri golf',
  '0875': 'mandiri'
};

var OCBC_SOF_MAP = {
  '4226': 'ocbc 90.N',
  '9376': 'ocbc platinum'
  // no card last-4 entry here → resolved to 'ocbc' (cash account) instead,
  // when the email shows a bank account number rather than a card number.
  // See parseOcbcTransfer_().
};
