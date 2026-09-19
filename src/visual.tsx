import { useEffect, useRef, useState } from "react";
import * as m from "motion/react-m";
import logo from "./assets/raskiday-logo.svg?raw";
import logoUrl from "./assets/raskiday-logo.svg";
import { eventRequest } from "./events-api";
import { formatDisplayMoney } from "./money";
import { calculateFinancials } from "./financials";
import type { EventCategory } from "./event-categories";

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
  id: string;
  sequence: number;
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
  amountKopecks: number;
  status: "pending" | "sent" | "confirmed" | "not_received";
  active: boolean;
  sentAt: string | null;
  confirmedAt: string | null;
  notReceivedAt: string | null;
};
export type ParticipantBalance = {
  userId: string;
  displayName: string;
  paidKopecks: number;
  shareKopecks: number;
  balanceKopecks: number;
};
export type ProposedTransfer = {
  sequence: number;
  senderId: string;
  senderName: string;
  receiverId: string;
  receiverName: string;
  amountKopecks: number;
};
export type SettlementPreview = {
  sourceEventVersion: number;
  balances: ParticipantBalance[];
  transfers: ProposedTransfer[];
};
export type SettlementRecord = {
  id: string;
  eventId: string;
  sourceEventVersion: number;
  active: boolean;
  createdAt: string;
  cancelledAt: string | null;
  transfersStartedAt: string | null;
  balances: ParticipantBalance[];
  transfers: TransferRecord[];
};
export function Logo({ className = "" }: { className?: string }) {
  return className === "splash-logo" ? (
    <span
      className={`logo ${className}`}
      aria-label="раскидай"
      role="img"
      dangerouslySetInnerHTML={{ __html: logo }}
    />
  ) : (
    <span className={`logo ${className}`}>
      <img src={logoUrl} alt="раскидай" />
    </span>
  );
}
const iconPaths: Record<EventCategory, React.ReactNode> = {
  trip: (
    <>
      <path d="M5 17 19 3" />
      <path d="m11 3 8 8" />
      <path d="M3 21h18" />
    </>
  ),
  food: (
    <>
      <path d="M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10" />
      <path d="M16 3v18M16 3c3 2 4 6 0 9" />
    </>
  ),
  party: (
    <>
      <path d="m5 20 4-11 6 6-10 5Z" />
      <path d="m14 5 1-2M18 8l3-1M17 12l2 2M9 4 7-2" />
    </>
  ),
  home: (
    <>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v11h14V10M9 21v-7h6v7" />
    </>
  ),
  leisure: (
    <>
      <path d="M4 16c3-8 5-8 8 0s5 8 8 0" />
      <path d="M4 20h16M7 7h10M9 3h6" />
    </>
  ),
  other: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M8 12h8M12 8v8" />
    </>
  ),
};

export function EventCategoryIcon({
  category,
  className = "",
}: {
  category: EventCategory;
  className?: string;
}) {
  return (
    <m.span
      className={`category-icon ${className}`}
      key={category}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2 }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {iconPaths[category]}
      </svg>
    </m.span>
  );
}
function balanceLabel(amount: number) {
  if (amount > 0)
    return (
      <>
        Вам вернут <strong>{formatDisplayMoney(amount)}</strong>
      </>
    );
  if (amount < 0)
    return (
      <>
        Вы должны <strong>{formatDisplayMoney(-amount)}</strong>
      </>
    );
  return <>Расчёты завершены</>;
}
export function useFinancials(
  token: string,
  eventId: string,
  userId: string,
  revision = 0,
) {
  const [value, setValue] = useState<{
    expenses: ExpenseRecord[];
    settlement: SettlementRecord | null;
  } | null>(null);
  const [error, setError] = useState("");
  const previousEventId = useRef(eventId);
  useEffect(() => {
    if (previousEventId.current !== eventId) setValue(null);
    previousEventId.current = eventId;
    if (!eventId) return;
    const controller = new AbortController();
    setError("");
    Promise.all([
      eventRequest<{ expenses: ExpenseRecord[] }>(
        token,
        "expenses.list",
        { eventId },
        { signal: controller.signal },
      ),
      eventRequest<{ settlement: SettlementRecord | null }>(
        token,
        "settlements.get",
        { eventId },
        { signal: controller.signal },
      ),
    ])
      .then(([expenses, settlement]) =>
        setValue({
          expenses: expenses.expenses,
          settlement: settlement.settlement,
        }),
      )
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить суммы.",
          );
      });
    return () => controller.abort();
  }, [token, eventId, revision]);
  const { total, paid, balance } = calculateFinancials(
    value?.expenses ?? [],
    value?.settlement?.transfers ?? [],
    userId,
  );
  return { value, error, total, paid, balance };
}
export function MoneySummary({
  total,
  paid,
  balance,
  loading = false,
  unavailable = false,
}: {
  total: number;
  paid: number;
  balance: number;
  loading?: boolean;
  unavailable?: boolean;
}) {
  return (
    <m.div className="money-summary" aria-busy={loading} layout>
      <div className="money-columns">
        <div>
          <span>Всего потрачено</span>
          <m.strong
            key={loading || unavailable ? "empty-total" : total}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          >
            {loading || unavailable ? "—" : formatDisplayMoney(total)}
          </m.strong>
        </div>
        <div>
          <span>Вы оплатили</span>
          <strong>
            {loading || unavailable ? "—" : formatDisplayMoney(paid)}
          </strong>
        </div>
      </div>
      <div className="balance-line">
        {unavailable
          ? "Суммы недоступны"
          : loading
            ? "Загружаем расчёты…"
            : balanceLabel(balance)}
      </div>
    </m.div>
  );
}
