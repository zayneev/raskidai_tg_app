import { useEffect, useRef, useState } from "react";
import logo from "./assets/raskiday-logo.svg?raw";
import logoUrl from "./assets/raskiday-logo.svg";
import { eventRequest } from "./events-api";
import { formatDisplayMoney } from "./money";
import { calculateFinancials } from "./financials";

export type ExpenseRecord = {
  id: string;
  author_id: string;
  author_name: string;
  title: string;
  amount_kopecks: number;
  created_at: string;
  version: number;
  shares: { user_id: string; display_name: string; amount_kopecks: number }[];
};
export type TransferRecord = {
  id: string; sequence: number; senderId: string; senderName: string;
  receiverId: string; receiverName: string; amountKopecks: number;
  status: "pending" | "sent" | "confirmed" | "not_received";
  active: boolean; sentAt: string | null; confirmedAt: string | null; notReceivedAt: string | null;
};
export type SettlementRecord = {
  id: string; eventId: string; sourceEventVersion: number; active: boolean;
  createdAt: string; cancelledAt: string | null; transfersStartedAt: string | null;
  balances: { userId: string; displayName: string; paidKopecks: number; shareKopecks: number; balanceKopecks: number }[];
  transfers: TransferRecord[];
};
export function Logo({ className = "" }: { className?: string }) {
  return className === "splash-logo"
    ? <span className={`logo ${className}`} aria-label="раскидай" role="img" dangerouslySetInnerHTML={{ __html: logo }} />
    : <span className={`logo ${className}`}><img src={logoUrl} alt="раскидай" /></span>;
}
function balanceLabel(amount: number) {
  if (amount > 0) return <>Вам вернут <strong>{formatDisplayMoney(amount)}</strong></>;
  if (amount < 0) return <>Вы должны <strong>{formatDisplayMoney(-amount)}</strong></>;
  return <>Расчёты завершены</>;
}
export function useFinancials(token: string, eventId: string, userId: string, revision = 0) {
  const [value, setValue] = useState<{ expenses: ExpenseRecord[]; settlement: SettlementRecord | null } | null>(null);
  const [error, setError] = useState("");
  const previousEventId = useRef(eventId);
  useEffect(() => {
    if (previousEventId.current !== eventId) setValue(null);
    previousEventId.current = eventId;
    if (!eventId) return;
    const controller = new AbortController();
    setError("");
    Promise.all([
      eventRequest<{ expenses: ExpenseRecord[] }>(token, "expenses.list", { eventId }, { signal: controller.signal }),
      eventRequest<{ settlement: SettlementRecord | null }>(token, "settlements.get", { eventId }, { signal: controller.signal }),
    ]).then(([expenses, settlement]) => setValue({ expenses: expenses.expenses, settlement: settlement.settlement }))
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Не удалось загрузить суммы."); });
    return () => controller.abort();
  }, [token, eventId, revision]);
  const { total, paid, balance } = calculateFinancials(value?.expenses ?? [], value?.settlement?.transfers ?? [], userId);
  return { value, error, total, paid, balance };
}
export function MoneySummary({ total, paid, balance, loading = false, unavailable = false }: { total: number; paid: number; balance: number; loading?: boolean; unavailable?: boolean }) {
  return <div className="money-summary" aria-busy={loading}>
    <div className="money-columns">
      <div><span>Общие расходы</span><strong>{loading || unavailable ? "—" : formatDisplayMoney(total)}</strong></div>
      <div><span>Вы оплатили</span><strong>{loading || unavailable ? "—" : formatDisplayMoney(paid)}</strong></div>
    </div>
    <div className="balance-line">{unavailable ? "Суммы недоступны" : loading ? "Загружаем расчёты…" : balanceLabel(balance)}</div>
  </div>;
}
