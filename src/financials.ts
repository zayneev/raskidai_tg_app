// UI totals use the source expense and share records; settlement status only
// changes the still-outstanding personal balance after final confirmation.
export function calculateFinancials(
  expenses: readonly { author_id: string; amount_kopecks: number; shares: readonly { user_id: string; amount_kopecks: number }[] }[],
  transfers: readonly { senderId: string; receiverId: string; amountKopecks: number; status: string; active: boolean }[],
  userId: string,
) {
  const total = expenses.reduce((sum, expense) => sum + expense.amount_kopecks, 0);
  const paid = expenses.reduce((sum, expense) => sum + (expense.author_id === userId ? expense.amount_kopecks : 0), 0);
  const share = expenses.reduce((sum, expense) => sum + (expense.shares.find((part) => part.user_id === userId)?.amount_kopecks ?? 0), 0);
  const transferred = transfers.reduce((sum, transfer) => {
    if (!transfer.active || transfer.status !== "confirmed") return sum;
    return sum + (transfer.senderId === userId ? transfer.amountKopecks : 0) - (transfer.receiverId === userId ? transfer.amountKopecks : 0);
  }, 0);
  return { total, paid, balance: paid - share + transferred };
}
