// Authentication proves identity; it does not by itself grant website access.
export function accountAccess(account) {
  const activeSubscription = account.plan?.status === 'active' && !!account.plan.id;
  const verifiedWallet = !!account.walletAddress;
  const credit = account.redemptionCredit ?? { tokens: 0, usdMicros: 0 };
  const redeemedCredit = (credit.tokens > 0 && account.allowance?.debt === 0)
    || (credit.usdMicros > 0 && account.credit?.debtMicros === 0);
  return {
    website: activeSubscription || verifiedWallet,
    onboarding: !(activeSubscription || verifiedWallet),
    apiKeyCreation: activeSubscription || redeemedCredit,
    activeSubscription, verifiedWallet, redeemedCredit,
    reason: activeSubscription ? 'active_subscription' : verifiedWallet ? 'verified_wallet' : 'subscription_or_wallet_required',
    apiKeyReason: activeSubscription ? 'active_subscription' : redeemedCredit ? 'redeemed_credit' : 'subscription_or_redeemed_credit_required',
  };
}
