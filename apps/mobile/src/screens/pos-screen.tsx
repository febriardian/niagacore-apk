import {
  addCashMovement,
  clearSaleDraft,
  clearPendingGatewayPayment,
  closeShift,
  commitLocalSale,
  createCreditSale,
  getAccountingSettings,
  getActiveShift,
  listBusinessRecords,
  listCustomerReceivables,
  listCustomerReceivablePayments,
  listLocalProducts,
  loadActiveSaleDraft,
  loadPendingGatewayPayment,
  logAuditEvent,
  openShift,
  saveActiveSaleDraft,
  saveBusinessRecord,
  savePendingGatewayPayment,
  settleCustomerReceivable,
  type CustomerReceivable,
  type ReceivablePaymentHistory,
  type LocalProduct,
  type BusinessRecord,
  type ShiftSummary,
} from "@/lib/remote-store";
import {
  calculateCart,
  calculateCreditPayment,
  evaluateStockSale,
  formatRupiah,
  type NegativeStockPolicy,
} from "@niagacore/domain";
import * as Crypto from "expo-crypto";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import {
  Image,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { createMutation } from "@/lib/mutations";
import { useBusinessRealtime } from "@/hooks/use-business-realtime";
import { buildReceiptHtml } from "@/lib/receipt";
import { supabase } from "@/lib/supabase";
import { qrisCheckoutErrorMessage } from "@/lib/qris-error";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { BarcodeScannerSheet } from "@/ui/barcode-scanner-sheet";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Header,
  ProductImage,
  Row,
  Screen,
  Segmented,
  Sheet,
} from "@/ui/components";
import { colors, radius } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert, translateUi } from "@/ui/localized-text";
import QRCode from "react-native-qrcode-svg";

type CartLine = LocalProduct & { quantity: number; discountMinor: number };

type QrisPayment = {
  saleId: string;
  orderId: string;
  receiptNumber: string;
  amount: number;
  qrString: string | null;
  qrImageUrl: string | null;
  paymentUrl: string | null;
  expiresAt: string;
  lines: CartLine[];
  customerName: string | null;
};

export function PosScreen({
  workspace,
  onChanged,
}: {
  workspace: ActiveWorkspace;
  onChanged: () => Promise<void>;
}) {
  const theme=useAppTheme();
  const db = useRemoteStore();
  const [products, setProducts] = React.useState<LocalProduct[]>([]);
  const [customers, setCustomers] = React.useState<BusinessRecord[]>([]);
  const [cart, setCart] = React.useState<CartLine[]>([]);
  const [search, setSearch] = React.useState("");
  const [shift, setShift] = React.useState<ShiftSummary | null>(null);
  const [shiftSheet, setShiftSheet] = React.useState(false);
  const [cashSheet, setCashSheet] = React.useState(false);
  const [paySheet, setPaySheet] = React.useState(false);
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [customerSheet, setCustomerSheet] = React.useState(false);
  const [customer, setCustomer] = React.useState<BusinessRecord | null>(null);
  const [newCustomerName, setNewCustomerName] = React.useState("");
  const [newCustomerPhone, setNewCustomerPhone] = React.useState("");
  const [creditSheet, setCreditSheet] = React.useState(false);
  const [creditPaidNow, setCreditPaidNow] = React.useState("");
  const [creditDueAt, setCreditDueAt] = React.useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [receivableSheet, setReceivableSheet] = React.useState(false);
  const [receivables, setReceivables] = React.useState<CustomerReceivable[]>([]);
  const [selectedReceivable, setSelectedReceivable] = React.useState<CustomerReceivable | null>(null);
  const [receivableAmount, setReceivableAmount] = React.useState("");
  const [receivablePayments, setReceivablePayments] = React.useState<ReceivablePaymentHistory[]>([]);
  const [qrisPayment, setQrisPayment] = React.useState<QrisPayment | null>(null);
  const [qrisChecking, setQrisChecking] = React.useState(false);
  const [qrisExpired,setQrisExpired]=React.useState(false);
  const [qrisWebError,setQrisWebError]=React.useState(false);
  const [overrideIds, setOverrideIds] = React.useState<string[]>([]);
  const draftId = React.useRef(Crypto.randomUUID());
  const draftRestored = React.useRef(false);
  const [stockPolicy, setStockPolicy] =
    React.useState<NegativeStockPolicy>("approval");
  const load = React.useCallback(async () => {
    const p = await listLocalProducts(db, workspace.tenantId, workspace.branchId);
    const active = await getActiveShift(db, workspace);
    const settings = await getAccountingSettings(db, workspace);
    const policy = settings.negativeStockPolicy;
    const customerRows = await listBusinessRecords(db, workspace, "customer");
    setProducts(p);
    setShift(active);
    setStockPolicy(policy);
    setCustomers(customerRows);
    if (!draftRestored.current) {
      const saved = await loadActiveSaleDraft(db, workspace);
      if (saved) {
        draftId.current = saved.id;
        setCart(saved.lines.flatMap((line) => {
          const product = p.find((item) => item.id === line.productId);
          return product ? [{ ...product, quantity: line.quantity, discountMinor: line.discountMinor }] : [];
        }));
        setCustomer(customerRows.find((item) => item.id === saved.customerId) ?? null);
      }
      draftRestored.current = true;
      const pending = await loadPendingGatewayPayment(db, workspace);
      if (pending) {
        const rawLines=Array.isArray(pending.payload.lines)?pending.payload.lines:[];
        const restoredLines=rawLines.flatMap((value)=>{
          if(!value||typeof value!=="object")return[];
          const row=value as {productId?:unknown;quantity?:unknown;discountMinor?:unknown};
          const product=p.find(item=>item.id===String(row.productId??"")),quantity=Number(row.quantity);
          return product&&Number.isFinite(quantity)&&quantity>0?[{...product,quantity,discountMinor:Math.max(0,Number(row.discountMinor)||0)}]:[];
        });
        setQrisPayment({ ...pending, lines: restoredLines, customerName: typeof pending.payload.customerName==="string"?pending.payload.customerName:null });
        setQrisExpired(new Date(pending.expiresAt).getTime()<=Date.now());
      }
    }
  }, [db, workspace]);
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useBusinessRealtime(workspace,load);
  React.useEffect(() => {
    if (!draftRestored.current) return;
    const timer = setTimeout(() => {
      if (cart.length) {
        void saveActiveSaleDraft(db, {
          id: draftId.current,
          context: workspace,
          customerId: customer?.id ?? null,
          lines: cart.map((line) => ({ productId: line.id, quantity: line.quantity, discountMinor: line.discountMinor })),
        });
      } else {
        void clearSaleDraft(db, draftId.current);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [cart, customer?.id, db, workspace]);
  const add = (p: LocalProduct) => {
    if (!shift) {
      localizedAlert(
        "Buka shift dahulu",
        "Kasir perlu membuka shift sebelum memulai transaksi.",
      );
      setShiftSheet(true);
      return;
    }
    const current = cart.find((x) => x.id === p.id)?.quantity ?? 0;
    const decision = evaluateStockSale({
      available: p.stock,
      requested: current + 1,
      policy: stockPolicy,
      role: workspace.role,
      approved: overrideIds.includes(p.id),
    });
    if (!decision.allowed) {
      if (!decision.requiresApproval || ["owner", "business_manager", "branch_manager", "supervisor"].includes(workspace.role)) {
        localizedAlert(
          "Stok tidak cukup",
          decision.requiresApproval
            ? "Transaksi diblokir. Minta persetujuan supervisor atau pemilik."
            : "Kebijakan usaha memblokir penjualan stok minus.",
        );
        return;
      }
      localizedAlert(
        "Stok tidak cukup",
        "Supervisor/pemilik dapat menyetujui penjualan stok minus. Tindakan ini dicatat untuk rekonsiliasi.",
        [
          { text: "Batal", style: "cancel" },
          {
            text: "Setujui",
            onPress: () => {
              setOverrideIds((ids) => [...ids, p.id]);
              void logAuditEvent(db, {
                id: Crypto.randomUUID(),
                context: workspace,
                action: "inventory.negative.override",
                resourceType: "product",
                resourceId: p.id,
                result: "success",
                reason: "Persetujuan langsung supervisor/pemilik",
              });
              setCart((c) => [
                ...c.filter((x) => x.id !== p.id),
                { ...p, quantity: current + 1, discountMinor: 0 },
              ]);
            },
          },
        ],
      );
      return;
    }
    setCart((c) => {
      const found = c.find((x) => x.id === p.id);
      return found
        ? c.map((x) => (x.id === p.id ? { ...x, quantity: x.quantity + 1 } : x))
        : [...c, { ...p, quantity: 1, discountMinor: 0 }];
    });
  };
  const totals = calculateCart(
    cart.map((x) => ({
      productId: x.id,
      name: x.name,
      quantity: x.quantity,
      priceMinor: x.priceMinor,
      discountMinor: x.discountMinor,
      taxRate: x.taxRate,
    })),
  );
  const visible = products.filter((p) =>
    `${p.name} ${p.sku} ${p.barcode ?? ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const openReceivables = React.useCallback(async () => {
    if (!shift) {
      localizedAlert("Buka shift dahulu", "Pembayaran utang tunai harus masuk ke shift aktif.");
      setShiftSheet(true);
      return;
    }
    try {
      const rows = await listCustomerReceivables(db, workspace);
      setReceivables(rows);
      setSelectedReceivable(null);
      setReceivableAmount("");
      setReceivablePayments([]);
      setReceivableSheet(true);
    } catch (error) {
      localizedAlert("Piutang pelanggan", error instanceof Error ? error.message : "Data piutang gagal dimuat.");
    }
  }, [db, shift, workspace]);
  const addCustomerQuickly = async () => {
    const name = newCustomerName.trim();
    if (name.length < 2) {
      localizedAlert("Periksa nama", "Nama pelanggan minimal 2 karakter.");
      return;
    }
    const id = Crypto.randomUUID();
    const payload = {
      kind: "customer",
      code: null,
      title: name,
      subtitle: newCustomerPhone.trim() || null,
      status: "active",
      amountMinor: 0,
      quantity: 0,
      dueAt: null,
      metadata: { name, phone: newCustomerPhone.trim() },
    };
    try {
      await saveBusinessRecord(db, {
        id,
        kind: "customer",
        title: name,
        subtitle: newCustomerPhone.trim() || null,
        status: "active",
        metadata: payload.metadata,
        context: workspace,
        mutation: await createMutation(workspace, "customer", id, "create", payload),
      });
      const rows = await listBusinessRecords(db, workspace, "customer");
      setCustomers(rows);
      setCustomer(rows.find((item) => item.id === id) ?? null);
      setNewCustomerName("");
      setNewCustomerPhone("");
      setCustomerSheet(false);
    } catch (error) {
      localizedAlert("Pelanggan gagal ditambahkan", error instanceof Error ? error.message : "Data tidak disimpan.");
    }
  };
  const checkoutCash = async () => {
    if (!cart.length || !shift) return;
    const id = Crypto.randomUUID(),
      receipt = `${workspace.branchCode}-${id.slice(0, 8).toUpperCase()}`;
    const lines = cart.map((x) => {
      const gross = Math.round(x.priceMinor * x.quantity),
        tax = Math.round(((gross - x.discountMinor) * x.taxRate) / 100);
      return {
        productId: x.id,
        name: x.name,
        quantity: x.quantity,
        priceMinor: x.priceMinor,
        costMinor: x.costMinor,
        discountMinor: x.discountMinor,
        taxMinor: tax,
        totalMinor: gross - x.discountMinor + tax,
      };
    });
    const event = await createMutation(workspace, "sale", id, "create", {
      receiptNumber: receipt,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      customerId: customer?.id ?? null,
      taxMinor: totals.taxMinor,
      totalMinor: totals.totalMinor,
      paymentMethod: "cash",
      shiftId: shift.id,
      negativeStockOverrides: overrideIds,
      lines,
    });
    try {
      await commitLocalSale(db, {
        id,
        receiptNumber: receipt,
        context: workspace,
        lines,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor,
        totalMinor: totals.totalMinor,
        customerId: customer?.id ?? null,
        paymentMethod: "cash",
        shiftId: shift.id,
        mutation: event,
      });
      await clearSaleDraft(db, draftId.current);
      draftId.current = Crypto.randomUUID();
      setCart([]);
      setOverrideIds([]);
      setCustomer(null);
      setPaySheet(false);
      await load();
      await onChanged();
      const receiptHtml = await buildReceiptHtml({
        saleId: id, receiptNumber: receipt, businessName: workspace.businessName,
        branchName: workspace.branchName, occurredAt: new Date().toISOString(), paymentMethod: "cash",
        lines: lines.map((line) => ({ name: line.name, quantity: line.quantity, totalMinor: line.totalMinor })),
        subtotalMinor: totals.subtotalMinor, discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor, totalMinor: totals.totalMinor, customerName: customer?.title ?? null,
      });
      localizedAlert(
        "Transaksi berhasil",
        `${receipt}\n${formatRupiah(totals.totalMinor)} diterima tunai.`,
        [
          { text: "Selesai" },
          {
            text: "Cetak",
            onPress: () => void Print.printAsync({ html: receiptHtml }),
          },
          {
            text: "Bagikan PDF",
            onPress: () =>
              void Print.printToFileAsync({ html: receiptHtml }).then(
                async ({ uri }) => {
                  if (await Sharing.isAvailableAsync())
                    await Sharing.shareAsync(uri, {
                      mimeType: "application/pdf",
                      dialogTitle: `Struk ${receipt}`,
                    });
                },
              ),
          },
        ],
      );
    } catch (error) {
      localizedAlert(
        "Transaksi gagal",
        error instanceof Error
          ? error.message
          : "Transaksi dibatalkan dengan aman.",
      );
    }
  };
  const checkoutCredit = async () => {
    if (!cart.length || !shift || !customer) {
      localizedAlert("Pelanggan wajib dipilih", "Transaksi utang harus terhubung ke nama pelanggan agar saldo dan pembayarannya dapat dilacak.");
      return;
    }
    let payment: { paidNowMinor: number; outstandingMinor: number };
    try {
      payment = calculateCreditPayment({ totalMinor: totals.totalMinor, paidNowMinor: Number(creditPaidNow || 0) });
    } catch {
      localizedAlert("Periksa nominal", "Nominal yang dibayar sekarang harus nol atau lebih, tetapi lebih kecil dari total tagihan.");
      return;
    }
    if (creditDueAt && !/^\d{4}-\d{2}-\d{2}$/.test(creditDueAt)) {
      localizedAlert("Periksa jatuh tempo", "Gunakan format YYYY-MM-DD.");
      return;
    }
    const id = Crypto.randomUUID();
    const receipt = `${workspace.branchCode}-U-${id.slice(0, 6).toUpperCase()}`;
    try {
      const result = await createCreditSale(db, {
        id,
        receiptNumber: receipt,
        context: workspace,
        customerId: customer.id,
        shiftId: shift.id,
        lines: cart.map((line) => ({ productId: line.id, quantity: line.quantity, discountMinor: line.discountMinor })),
        paidNowMinor: payment.paidNowMinor,
        dueAt: creditDueAt || null,
      });
      const receiptLines = cart.map((line) => ({
        name: line.name,
        quantity: line.quantity,
        totalMinor: Math.round(line.priceMinor * line.quantity - line.discountMinor + ((line.priceMinor * line.quantity - line.discountMinor) * line.taxRate / 100)),
      }));
      const html = await buildReceiptHtml({
        saleId: id,
        receiptNumber: receipt,
        businessName: workspace.businessName,
        branchName: workspace.branchName,
        occurredAt: new Date().toISOString(),
        paymentMethod: "utang",
        lines: receiptLines,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor,
        totalMinor: result.totalMinor,
        customerName: customer.title,
        paidMinor: result.paidNowMinor,
        outstandingMinor: result.outstandingMinor,
        dueAt: creditDueAt || null,
      });
      await clearSaleDraft(db, draftId.current);
      draftId.current = Crypto.randomUUID();
      setCart([]);
      setOverrideIds([]);
      setCustomer(null);
      setCreditPaidNow("");
      setCreditSheet(false);
      setPaySheet(false);
      await load();
      await onChanged();
      localizedAlert("Transaksi utang tersimpan", `${receipt}\nDibayar ${formatRupiah(result.paidNowMinor)}\nSisa piutang ${formatRupiah(result.outstandingMinor)}`, [
        { text: "Selesai" },
        { text: "Cetak", onPress: () => void Print.printAsync({ html }) },
        { text: "Bagikan PDF", onPress: () => void Print.printToFileAsync({ html }).then(async ({ uri }) => { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Struk ${receipt}` }); }) },
      ]);
    } catch (error) {
      localizedAlert("Transaksi utang gagal", error instanceof Error ? error.message : "Transaksi tidak disimpan.");
    }
  };
  const submitReceivablePayment = async () => {
    if (!selectedReceivable || !shift) return;
    const amountMinor = Math.round(Number(receivableAmount));
    if (!Number.isFinite(amountMinor) || amountMinor <= 0 || amountMinor > selectedReceivable.outstandingMinor) {
      localizedAlert("Periksa nominal", `Pembayaran harus antara Rp1 dan ${formatRupiah(selectedReceivable.outstandingMinor)}.`);
      return;
    }
    try {
      const result = await settleCustomerReceivable(db, {
        paymentId: Crypto.randomUUID(),
        receivableId: selectedReceivable.id,
        amountMinor,
        shiftId: shift.id,
        context: workspace,
      });
      const rows = await listCustomerReceivables(db, workspace);
      setReceivables(rows);
      const updated=rows.find((item)=>item.id===selectedReceivable.id);
      setReceivablePayments(await listCustomerReceivablePayments(db,workspace.tenantId,selectedReceivable.saleId));
      setSelectedReceivable(updated??null);
      setReceivableAmount("");
      await onChanged();
      localizedAlert("Pembayaran dicatat", `Diterima ${formatRupiah(result.paidMinor)}. Sisa utang pelanggan ${formatRupiah(result.outstandingMinor)}.`);
    } catch (error) {
      localizedAlert("Pembayaran gagal", error instanceof Error ? error.message : "Pembayaran tidak disimpan.");
    }
  };
  const checkoutQris = async () => {
    if (!workspace.qrisEnabled) {
      localizedAlert(
        "QRIS terkunci",
        "QRIS menunggu verifikasi merchant dan aktivasi resmi Midtrans.",
      );
      return;
    }
    if (!supabase || !shift || !cart.length) return;
    const saleId = Crypto.randomUUID();
    const { data, error } = await supabase.functions.invoke(
      "create-midtrans-transaction",
      {
        body: {
          saleId,
          branchId: workspace.branchId,
          deviceId: workspace.deviceId,
          receiptNumber: `QR-${saleId.slice(0, 8).toUpperCase()}`,
          lines: cart.map((x) => ({
            productId: x.id,
            quantity: x.quantity,
            discountMinor: x.discountMinor,
          })),
          shiftId: shift.id,
          customerId: customer?.id ?? null,
        },
      },
    );
    if (error) {
      localizedAlert("QRIS", await qrisCheckoutErrorMessage(error));
      return;
    }
    if (!data?.qrString && !data?.qrImageUrl && !data?.paymentUrl) {
      localizedAlert("QRIS", "Kode pembayaran tidak diterima.");
      return;
    }
    setPaySheet(false);
    const pendingPayment: QrisPayment = {
      saleId: data.saleId as string,
      orderId: data.orderId as string,
      receiptNumber: data.receiptNumber as string,
      amount: data.amount as number,
      qrString: (data.qrString as string | null) ?? null,
      qrImageUrl: (data.qrImageUrl as string | null) ?? null,
      paymentUrl: (data.paymentUrl as string | null) ?? null,
      expiresAt: data.expiresAt as string,
      lines: cart.map((line) => ({ ...line })),
      customerName: customer?.title ?? null,
    };
    await savePendingGatewayPayment(db, workspace, {
      ...pendingPayment,
      payload: { lines: pendingPayment.lines, customerName: pendingPayment.customerName },
    });
    setQrisExpired(false);
    setQrisWebError(false);
    setQrisPayment(pendingPayment);
  };
  React.useEffect(() => {
    if (!qrisPayment || !supabase) return;
    const backend = supabase;
    const pendingPayment = qrisPayment;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      setQrisExpired(new Date(pendingPayment.expiresAt).getTime()<=Date.now());
      setQrisChecking(true);
      const { data, error } = await backend.functions.invoke("reconcile-midtrans", { body: { orderId: pendingPayment.orderId } });
      setQrisChecking(false);
      if (stopped || error) return;
      if (data?.status === "paid" || data?.status === "duplicate") {
        const paid = pendingPayment;
        setQrisPayment(null);
        await clearPendingGatewayPayment(db, paid.saleId);
        await clearSaleDraft(db, draftId.current);
        draftId.current = Crypto.randomUUID();
        setCart([]);
        setOverrideIds([]);
        setCustomer(null);
        await load();
        await onChanged();
        const paidTotals = calculateCart(paid.lines.map((line) => ({ productId: line.id, name: line.name, quantity: line.quantity, priceMinor: line.priceMinor, discountMinor: line.discountMinor, taxRate: line.taxRate })));
        const html = await buildReceiptHtml({
          saleId: paid.saleId, receiptNumber: paid.receiptNumber, businessName: workspace.businessName,
          branchName: workspace.branchName, occurredAt: new Date().toISOString(), paymentMethod: "qris",
          lines: paid.lines.map((line) => ({ name: line.name, quantity: line.quantity, totalMinor: Math.round(line.priceMinor * line.quantity - line.discountMinor + ((line.priceMinor * line.quantity - line.discountMinor) * line.taxRate / 100)) })),
          subtotalMinor: paidTotals.subtotalMinor, discountMinor: paidTotals.discountMinor,
          taxMinor: paidTotals.taxMinor, totalMinor: paidTotals.totalMinor, customerName: paid.customerName,
        });
        localizedAlert("Pembayaran berhasil", `${paid.receiptNumber}\n${formatRupiah(paid.amount)} diterima melalui QRIS.`, [
          { text: "Selesai" },
          { text: "Cetak", onPress: () => void Print.printAsync({ html }) },
          { text: "Bagikan PDF", onPress: () => void Print.printToFileAsync({ html }).then(async ({ uri }) => { if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: "application/pdf", dialogTitle: `Struk ${paid.receiptNumber}` }); }) },
        ]);
      }
      if (["expire", "cancel", "deny", "void"].includes(String(data?.providerStatus ?? data?.status))) {
        await clearPendingGatewayPayment(db, pendingPayment.saleId);
        setQrisPayment(null);
        localizedAlert("Pembayaran tidak selesai", "Keranjang tetap dipertahankan dan dapat dibayar kembali.");
      }
    };
    void check();
    const timer = setInterval(() => void check(), 3_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [db, load, onChanged, qrisPayment, workspace.branchName, workspace.businessName]);
  return (
    <Screen>
      <Header
        title="Kasir"
        subtitle={
          shift
            ? `Shift aktif sejak ${new Date(shift.openedAt).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}`
            : "Shift belum dibuka"
        }
        right={
          <Badge
            text={shift ? "Shift aktif" : "Tutup"}
            tone={shift ? "green" : "amber"}
          />
        }
      />
      <View style={s.shiftActions}>
        <Button
          compact
          variant={shift ? "outline" : "primary"}
          title={shift ? "Kelola kas" : "Buka shift"}
          onPress={() => (shift ? setCashSheet(true) : setShiftSheet(true))}
        />
        {shift && (
          <Button
            compact
            variant="outline"
            title="Tutup shift"
            onPress={() => setShiftSheet(true)}
          />
        )}
        {shift && (
          <Button compact variant="outline" title="Bayar utang" onPress={() => void openReceivables()} />
        )}
      </View>
      <View style={[s.search,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
        <Text style={s.searchIcon}>⌕</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={translateUi("Cari / scan SKU atau barcode")}
          placeholderTextColor={theme.colors.muted}
          style={[s.searchInput,{color:theme.colors.ink}]}
          returnKeyType="done"
          onSubmitEditing={() => {
            const value=search.trim();
            const exact=products.find((product)=>product.barcode===value||product.sku===value);
            if(exact){add(exact);setSearch("");}
            else if(value)localizedAlert("Produk tidak ditemukan",`Kode ${value} belum terdaftar.`);
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Pindai barcode"
          onPress={() => setScannerOpen(true)}
          style={[s.scanButton,{backgroundColor:theme.colors.blueSoft}]}
        >
          <Text style={s.scanButtonText}>▦</Text>
        </Pressable>
      </View>
      <View style={s.catalogHead}>
        <View><Text style={s.catalogTitle}>Pilih produk</Text><Text style={s.catalogDetail}>Ketuk produk untuk menambahkannya ke keranjang</Text></View>
        <Badge text={`${visible.length} produk`} tone="blue"/>
      </View>
      {visible.length===0?<EmptyState title="Produk tidak ditemukan" detail="Coba nama, SKU, atau barcode yang berbeda."/>:<View style={s.catalog}>
        {visible.map((p) => (
          <Pressable
            key={p.id}
            onPress={() => add(p)}
            style={({ pressed }) => [s.product,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}, pressed && s.pressed]}
          >
            <View style={[s.productImageWrap,{backgroundColor:theme.colors.cream}]}><ProductImage uri={p.imageUri} name={p.name} size={106}/></View>
            <Text numberOfLines={2} style={s.productName}>
              {p.name}
            </Text>
            <View style={s.productMeta}><View style={s.flex}><Text style={s.productPrice}>{formatRupiah(p.priceMinor)}</Text><Text style={[s.productStock, p.stock <= p.minimumStock && s.low]}>{p.stock} {p.unit}</Text></View><View style={s.addProduct}><Text style={s.addProductText}>＋</Text></View></View>
          </Pressable>
        ))}
      </View>}
      <Card>
        <View style={s.cartHead}>
          <Text style={s.cartTitle}>Keranjang</Text>
          <Badge text={`${totals.itemCount} item`} tone="blue" />
        </View>
        {cart.length === 0 ? (
          <EmptyState
            title="Keranjang kosong"
            detail="Pilih produk untuk memulai transaksi."
            embedded
          />
        ) : (
          cart.map((item) => (
            <View key={item.id} style={s.cartRow}>
              <ProductImage uri={item.imageUri} name={item.name} size={42}/>
              <View style={s.flex}>
                <Text style={s.itemName}>{item.name}</Text>
                <Text style={s.itemDetail}>
                  {formatRupiah(item.priceMinor)} × {item.quantity}
                </Text>
                <View style={s.discountEditor}>
                  <Text style={s.discountLabel}>Diskon Rp</Text>
                  <TextInput
                    value={String(item.discountMinor || "")}
                    onChangeText={(value) => {
                      const gross = item.priceMinor * item.quantity;
                      const roleLimit =
                        ["cashier", "waiter"].includes(workspace.role) ? gross * 0.1 : gross;
                      const discount = Math.min(
                        roleLimit,
                        Math.max(0, Math.round(Number(value) || 0)),
                      );
                      setCart((lines) =>
                        lines.map((line) =>
                          line.id === item.id
                            ? { ...line, discountMinor: discount }
                            : line,
                        ),
                      );
                    }}
                    keyboardType="numeric"
                    placeholder={
                      ["cashier", "waiter"].includes(workspace.role) ? translateUi("maks. 10%") : "0"
                    }
                    style={s.discountInput}
                  />
                </View>
              </View>
              <View style={s.stepper}>
                <Pressable
                  onPress={() =>
                    setCart((c) =>
                      c.flatMap((x) =>
                        x.id !== item.id
                          ? [x]
                          : x.quantity > 1
                            ? [{ ...x, quantity: x.quantity - 1 }]
                            : [],
                      ),
                    )
                  }
                  style={s.step}
                >
                  <Text style={s.stepText}>−</Text>
                </Pressable>
                <Text style={s.qty}>{item.quantity}</Text>
                <Pressable onPress={() => add(item)} style={s.step}>
                  <Text style={s.stepText}>＋</Text>
                </Pressable>
              </View>
            </View>
          ))
        )}
        {cart.length > 0 && (
          <>
            <View style={s.totalRow}>
              <Text style={s.totalLabel}>Subtotal</Text>
              <Text style={s.totalText}>
                {formatRupiah(totals.subtotalMinor)}
              </Text>
            </View>
            {totals.discountMinor > 0 && (
              <View style={s.totalRow}>
                <Text style={s.totalLabel}>Diskon</Text>
                <Text style={s.discount}>
                  − {formatRupiah(totals.discountMinor)}
                </Text>
              </View>
            )}
            <View style={s.grand}>
              <Text style={s.grandLabel}>Total</Text>
              <Text style={s.grandValue}>
                {formatRupiah(totals.totalMinor)}
              </Text>
            </View>
            <Button
              title="Pilih pembayaran"
              onPress={() => setPaySheet(true)}
            />
          </>
        )}
      </Card>
      <ShiftSheet
        visible={shiftSheet}
        shift={shift}
        workspace={workspace}
        close={() => setShiftSheet(false)}
        saved={async () => {
          setShiftSheet(false);
          await load();
          await onChanged();
        }}
      />
      <CashMovementSheet
        visible={cashSheet}
        shift={shift}
        workspace={workspace}
        close={() => setCashSheet(false)}
        saved={async () => {
          setCashSheet(false);
          await onChanged();
        }}
      />
      <Sheet
        visible={paySheet}
        title="Pembayaran"
        onClose={() => setPaySheet(false)}
      >
        <Row title="Total tagihan" detail={formatRupiah(totals.totalMinor)} />
        <Row
          title="Pelanggan"
          detail={customer?.title ?? "Umum / tanpa pelanggan"}
          onPress={() => setCustomerSheet(true)}
        />
        <Button title="Bayar tunai" onPress={() => void checkoutCash()} />
        <Button
          variant={workspace.qrisEnabled ? "secondary" : "outline"}
          title={workspace.qrisEnabled ? "Bayar QRIS" : "QRIS belum aktif"}
          onPress={() => void checkoutQris()}
        />
        <Button
          variant="outline"
          title="Bayar dengan utang"
          onPress={() => {
            if (!customer) {
              localizedAlert("Pilih pelanggan", "Nama pelanggan wajib dipilih sebelum membuat transaksi utang.");
              setCustomerSheet(true);
              return;
            }
            setPaySheet(false);
            setCreditSheet(true);
          }}
        />
        <Text style={s.note}>
          Status pembayaran gateway hanya dapat ditetapkan oleh webhook server
          Midtrans.
        </Text>
      </Sheet>
      <Sheet visible={creditSheet} title="Pembayaran utang" onClose={() => setCreditSheet(false)}>
        <Row title="Pelanggan" detail={customer?.title ?? "Belum dipilih"} onPress={() => setCustomerSheet(true)} />
        <Row title="Total belanja" detail={formatRupiah(totals.totalMinor)} />
        <Field
          label="Dibayar tunai sekarang"
          value={creditPaidNow}
          onChangeText={setCreditPaidNow}
          keyboardType="numeric"
          placeholder="0"
        />
        <View style={[s.creditSummary,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
          <Text style={s.creditSummaryLabel}>SISA MASUK PIUTANG</Text>
          <Text style={s.creditSummaryValue}>{formatRupiah(Math.max(0, totals.totalMinor - Math.max(0, Number(creditPaidNow) || 0)))}</Text>
        </View>
        <Field label="Jatuh tempo" value={creditDueAt} onChangeText={setCreditDueAt} placeholder="YYYY-MM-DD" />
        <Text style={s.note}>Pembayaran awal dan cicilan berikutnya dicatat terpisah. Saldo pelanggan, kas shift, jurnal, dan laporan akan diperbarui otomatis.</Text>
        <Button title="Simpan transaksi utang" onPress={() => void checkoutCredit()} />
      </Sheet>
      <Sheet visible={receivableSheet} title="Bayar utang pelanggan" onClose={() => setReceivableSheet(false)}>
        {receivables.length === 0 ? (
          <EmptyState title="Tidak ada piutang aktif" detail="Semua utang pelanggan sudah lunas atau belum ada transaksi utang." embedded />
        ) : selectedReceivable ? (
          <>
            <Row title={selectedReceivable.customerName} detail={selectedReceivable.receiptNumber} />
            <Row title="Total awal" detail={formatRupiah(selectedReceivable.originalMinor)} />
            <Row title="Sudah dibayar" detail={formatRupiah(selectedReceivable.settledMinor)} />
            <View style={[s.creditSummary,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
              <Text style={s.creditSummaryLabel}>SISA UTANG PELANGGAN</Text>
              <Text style={s.creditSummaryValue}>{formatRupiah(selectedReceivable.outstandingMinor)}</Text>
            </View>
            <Field label="Nominal pembayaran tunai" value={receivableAmount} onChangeText={setReceivableAmount} keyboardType="numeric" />
            <Button variant="outline" title="Bayar lunas" onPress={() => setReceivableAmount(String(selectedReceivable.outstandingMinor))} />
            <Button title="Catat pembayaran" onPress={() => void submitReceivablePayment()} />
            <View style={[s.quickCustomer,{borderColor:theme.colors.line}]}>
              <Text style={s.creditSummaryLabel}>RIWAYAT CICILAN</Text>
              {receivablePayments.length===0?<Text style={s.note}>Belum ada pembayaran.</Text>:receivablePayments.map((payment)=><Row key={payment.id} title={payment.kind==="initial"?"Pembayaran awal":"Cicilan"} detail={`${new Date(payment.paidAt).toLocaleString("id-ID")} • ${payment.method==="cash"?"Tunai":payment.method.toUpperCase()}`} right={<Text style={s.installmentAmount}>{formatRupiah(payment.amountMinor)}</Text>}/>) }
            </View>
            <Button variant="ghost" title="Pilih tagihan lain" onPress={() => { setSelectedReceivable(null); setReceivableAmount(""); }} />
          </>
        ) : (
          <>
            <Text style={s.note}>Pilih tagihan berdasarkan nama pelanggan dan nomor struk.</Text>
            {receivables.map((item) => (
              <Row
                key={item.id}
                title={item.customerName}
                detail={`${item.receiptNumber} • Sisa ${formatRupiah(item.outstandingMinor)}${item.dueAt ? ` • Jatuh tempo ${item.dueAt}` : ""}`}
                onPress={() => { setSelectedReceivable(item); setReceivableAmount(""); void listCustomerReceivablePayments(db,workspace.tenantId,item.saleId).then(setReceivablePayments).catch(()=>setReceivablePayments([])); }}
              />
            ))}
          </>
        )}
      </Sheet>
      <Sheet
        visible={customerSheet}
        title="Pilih pelanggan"
        onClose={() => setCustomerSheet(false)}
      >
        <Row
          title="Umum / tanpa pelanggan"
          onPress={() => {
            setCustomer(null);
            setCustomerSheet(false);
          }}
        />
        {customers.map((item) => (
          <Row
            key={item.id}
            title={item.title}
            detail={item.subtitle ?? item.code ?? undefined}
            onPress={() => {
              setCustomer(item);
              setCustomerSheet(false);
            }}
          />
        ))}
        <View style={[s.quickCustomer,{borderColor:theme.colors.line}]}>
          <Text style={s.creditSummaryLabel}>PELANGGAN BARU</Text>
          <Field label="Nama pembeli" value={newCustomerName} onChangeText={setNewCustomerName} />
          <Field label="Nomor HP (opsional)" value={newCustomerPhone} onChangeText={setNewCustomerPhone} keyboardType="phone-pad" />
          <Button variant="outline" title="Tambah dan pilih pelanggan" onPress={() => void addCustomerQuickly()} />
        </View>
      </Sheet>
      <BarcodeScannerSheet
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(value) => {
          setSearch(value);
          setScannerOpen(false);
          const exact = products.find(
            (product) => product.barcode === value || product.sku === value,
          );
          if (exact) add(exact);
          else localizedAlert("Produk tidak ditemukan", `Kode ${value} belum terdaftar.`);
        }}
      />
      <Modal visible={Boolean(qrisPayment)} animationType="slide" onRequestClose={() => setQrisPayment(null)}>
        <SafeAreaView style={[s.qrisModal,{backgroundColor:theme.colors.cream}]} edges={["top","bottom"]}>
          {qrisPayment ? <>
            <View style={s.qrisModalHeader}>
              <View style={s.flex}><Text style={s.qrisModalTitle}>Bayar dengan QRIS</Text><Text style={s.qrisModalMeta}>{qrisPayment.receiptNumber} • berlaku sampai {new Date(qrisPayment.expiresAt).toLocaleTimeString("id-ID",{hour:"2-digit",minute:"2-digit"})}</Text></View>
              <Pressable accessibilityRole="button" accessibilityLabel="Tutup QRIS" onPress={()=>setQrisPayment(null)} style={s.qrisModalClose}><Text style={s.qrisModalCloseText}>×</Text></Pressable>
            </View>
            <View style={s.qrisViewport}>
              {qrisPayment.paymentUrl ? qrisWebError ? <View style={s.qrisWebFallback}><Text style={s.note}>Halaman QRIS tidak dapat dimuat di aplikasi.</Text><Button title="Coba lagi" variant="outline" onPress={()=>setQrisWebError(false)}/><Button title="Buka di browser" variant="ghost" onPress={()=>void Linking.openURL(qrisPayment.paymentUrl!)}/></View> :
                <WebView
                  style={s.qrisWeb}
                  source={{uri:qrisPayment.paymentUrl}}
                  originWhitelist={["https://*"]}
                  javaScriptEnabled
                  domStorageEnabled
                  scrollEnabled
                  nestedScrollEnabled={false}
                  setSupportMultipleWindows={false}
                  onError={()=>setQrisWebError(true)}
                  onHttpError={({nativeEvent})=>{if(nativeEvent.statusCode>=400)setQrisWebError(true)}}
                  onShouldStartLoadWithRequest={({url})=>{
                    if(url.startsWith("https://")||url.startsWith("about:blank"))return true;
                    void Linking.openURL(url).catch(()=>undefined);
                    return false;
                  }}
                /> : <View style={s.qrisNative}>
                  {qrisPayment.qrString ? <QRCode value={qrisPayment.qrString} size={260}/> : qrisPayment.qrImageUrl ? <Image source={{uri:qrisPayment.qrImageUrl}} style={s.qrisImage}/> : null}
                </View>}
            </View>
            <View style={[s.qrisFooter,{backgroundColor:theme.colors.cream,borderColor:theme.colors.line}]}>
              <View style={s.qrisFooterHead}><Text style={s.qrisFooterAmount}>{formatRupiah(qrisPayment.amount)}</Text><Badge text={qrisExpired?"Kedaluwarsa":qrisChecking?"Memeriksa":"Menunggu pembayaran"} tone={qrisExpired?"red":"amber"}/></View>
              <Text style={s.qrisFooterNote}>{qrisExpired?"Waktu pembayaran berakhir. Status akhir sedang diperiksa.":"Pembayaran hanya dinyatakan berhasil setelah dikonfirmasi Midtrans."}</Text>
              <Button compact variant="outline" title="Periksa sekarang" onPress={() => setQrisPayment((value) => value ? { ...value } : value)}/>
            </View>
          </>:null}
        </SafeAreaView>
      </Modal>
    </Screen>
  );
}

function ShiftSheet({
  visible,
  shift,
  workspace,
  close,
  saved,
}: {
  visible: boolean;
  shift: ShiftSummary | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const [amount, setAmount] = React.useState("0");
  const [reason, setReason] = React.useState("");
  const [busy,setBusy]=React.useState(false);
  const submit = async () => {
    if(busy)return;
    setBusy(true);
    try {
      if (!shift) {
        const id = Crypto.randomUUID();
        await openShift(db, workspace, {
          id,
          openingMinor: Math.round(Number(amount) || 0),
          mutation: await createMutation(workspace, "shift", id, "create", {
            openingMinor: Math.round(Number(amount) || 0),
          }),
        });
      } else {
        const variance = await closeShift(db, workspace, {
          shiftId: shift.id,
          closingMinor: Math.round(Number(amount) || 0),
          reason: reason.trim() || undefined,
          mutation: await createMutation(workspace, "shift", shift.id, "update", {
            closingMinor: Math.round(Number(amount) || 0),
            reason: reason.trim(),
          }),
        });
        localizedAlert("Shift ditutup", `Selisih kas: ${formatRupiah(variance)}`);
      }
      await saved();
    } catch (error) {
      const message=error instanceof Error?error.message:"Gagal memproses shift";
      if(message.includes("one_open_shift_per_user_device_branch")){
        await saved();
        localizedAlert("Shift sudah aktif","Shift yang sudah terbuka digunakan kembali. Data kas tidak dibuat ganda.");
        return;
      }
      if(message.includes("one_open_shift_per_device")){
        localizedAlert("Pembaruan database diperlukan","Aturan shift lama masih aktif. Terapkan migrasi database terbaru, lalu coba kembali.");
        return;
      }
      localizedAlert(
        "Shift",
        message.includes("variance_reason_required")
          ? "Isi alasan selisih sebelum menutup shift."
          : message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      title={shift ? "Tutup shift" : "Buka shift"}
      onClose={close}
    >
      <Field
        label={shift ? "Kas aktual" : "Saldo kas awal"}
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
      />
      {shift && (
        <Field
          label="Alasan selisih (wajib jika tidak seimbang)"
          value={reason}
          onChangeText={setReason}
        />
      )}
      <Button
        disabled={busy}
        title={busy?"Memproses...":shift ? "Hitung & tutup shift" : "Buka shift"}
        onPress={() => void submit()}
      />
    </Sheet>
  );
}
function CashMovementSheet({
  visible,
  shift,
  workspace,
  close,
  saved,
}: {
  visible: boolean;
  shift: ShiftSummary | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const [direction, setDirection] = React.useState<"in" | "out">("in");
  const [category, setCategory] = React.useState("Modal kas");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const submit = async () => {
    if (!shift) return;
    const value = Math.round(Number(amount));
    if (!Number.isFinite(value) || value <= 0 || category.trim().length < 3) {
      localizedAlert("Periksa formulir");
      return;
    }
    const id = Crypto.randomUUID();
    await addCashMovement(db, workspace, {
      id,
      shiftId: shift.id,
      direction,
      category: category.trim(),
      amountMinor: value,
      note: note.trim(),
      mutation: await createMutation(workspace, "cash_movement", id, "create", {
        shiftId: shift.id,
        direction,
        category,
        amountMinor: value,
        note,
      }),
    });
    await saved();
  };
  return (
    <Sheet visible={visible} title="Kas masuk / keluar" onClose={close}>
      <Segmented
        value={direction}
        onChange={setDirection}
        items={[
          { value: "in", label: "Kas masuk" },
          { value: "out", label: "Kas keluar" },
        ]}
      />
      <Field label="Kategori" value={category} onChangeText={setCategory} />
      <Field
        label="Jumlah"
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
      />
      <Field label="Catatan" value={note} onChangeText={setNote} />
      <Button title="Catat pergerakan kas" onPress={() => void submit()} />
    </Sheet>
  );
}

const s = StyleSheet.create({
  shiftActions: { flexDirection: "row", gap: 9 },
  search: {
    height: 48,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
  },
  searchIcon: { fontSize: 21, color: colors.muted },
  searchInput: {
    flex: 1,
    height: "100%",
    paddingHorizontal: 9,
    color: colors.ink,
  },
  scanButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    backgroundColor: colors.blueSoft,
  },
  scanButtonText: { color: colors.blue, fontWeight: "900", fontSize: 19 },
  catalogHead:{flexDirection:"row",alignItems:"flex-end",justifyContent:"space-between",gap:10,marginTop:2},
  catalogTitle:{fontSize:15,fontWeight:"900",color:colors.ink},
  catalogDetail:{fontSize:10,color:colors.muted,lineHeight:14,marginTop:2},
  catalog: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  product: {
    width: "48.4%",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 11,
    minHeight: 190,
  },
  pressed: { opacity: 0.65 },
  productImageWrap:{alignItems:"center",backgroundColor:colors.cream,borderRadius:16,paddingVertical:7},
  productName: {
    fontSize: 13,
    fontWeight: "900",
    color: colors.ink,
    minHeight: 34,
    marginTop: 9,
  },
  productMeta:{flexDirection:"row",alignItems:"flex-end",gap:6,marginTop:"auto"},
  productPrice: {
    fontSize: 12,
    fontWeight: "900",
    color: colors.blue,
    marginTop: 3,
  },
  productStock: { fontSize: 10, color: colors.muted, marginTop: 4 },
  addProduct:{width:30,height:30,borderRadius:10,backgroundColor:colors.blue,alignItems:"center",justifyContent:"center"},
  addProductText:{fontSize:16,color:colors.white,fontWeight:"900",lineHeight:18},
  low: { color: colors.red, fontWeight: "900" },
  cartHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cartTitle: { fontSize: 17, fontWeight: "900", color: colors.ink },
  cartRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  flex: { flex: 1, minWidth: 0 },
  itemName: { fontSize: 13, fontWeight: "900", color: colors.ink },
  itemDetail: { fontSize: 11, color: colors.muted, marginTop: 3 },
  discountEditor: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 7,
    marginTop: 7,
  },
  discountLabel: { color: colors.muted, fontSize: 10, fontWeight: "700" },
  discountInput: {
    width: 104,
    height: 38,
    paddingHorizontal: 10,
    paddingVertical: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    color: colors.ink,
    fontSize: 13,
    textAlignVertical: "center",
  },
  stepper: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0, marginTop: 2 },
  step: {
    width: 31,
    height: 31,
    borderRadius: 10,
    backgroundColor: "#F0F2F5",
    alignItems: "center",
    justifyContent: "center",
  },
  stepText: { fontSize: 17, fontWeight: "900", color: colors.navy },
  qty: {
    minWidth: 26,
    textAlign: "center",
    fontWeight: "900",
    color: colors.ink,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 12,
  },
  totalLabel: { fontSize: 12, color: colors.muted },
  totalText: { fontSize: 12, fontWeight: "800", color: colors.ink },
  discount: { fontSize: 12, fontWeight: "800", color: colors.green },
  grand: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingVertical: 16,
  },
  grandLabel: { fontSize: 15, fontWeight: "900", color: colors.ink },
  grandValue: { fontSize: 22, fontWeight: "900", color: colors.navy },
  qrisBox: {
    minHeight: 250,
    alignItems: "center",
    justifyContent: "center",
    padding: 10,
    backgroundColor: "#FFFFFF",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  qrisImage: { width: 230, height: 230, resizeMode: "contain" },
  qrisModal:{flex:1},
  qrisModalHeader:{minHeight:64,flexDirection:"row",alignItems:"center",gap:12,paddingHorizontal:16,paddingVertical:10},
  qrisModalTitle:{fontSize:20,fontWeight:"900",color:colors.ink},
  qrisModalMeta:{fontSize:11,color:colors.muted,marginTop:3},
  qrisModalClose:{width:40,height:40,borderRadius:20,alignItems:"center",justifyContent:"center",backgroundColor:colors.blueSoft},
  qrisModalCloseText:{fontSize:28,lineHeight:30,fontWeight:"700",color:colors.blue},
  qrisViewport:{flex:1,overflow:"hidden",backgroundColor:colors.white,borderTopWidth:1,borderBottomWidth:1,borderColor:colors.line},
  qrisWeb:{flex:1,backgroundColor:colors.white},
  qrisNative:{flex:1,alignItems:"center",justifyContent:"center",padding:16},
  qrisWebFallback: { flex: 1, justifyContent: "center", gap: 10, padding: 20 },
  qrisFooter:{borderTopWidth:1,paddingHorizontal:16,paddingTop:12,paddingBottom:8,gap:8},
  qrisFooterHead:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:10},
  qrisFooterAmount:{fontSize:22,fontWeight:"900",color:colors.navy},
  qrisFooterNote:{fontSize:11,lineHeight:16,color:colors.muted},
  qrisAmount: { fontSize: 24, fontWeight: "900", color: colors.navy, textAlign: "center" },
  note: { fontSize: 11, color: colors.muted, lineHeight: 17 },
  creditSummary: { borderWidth: 1, borderRadius: radius.md, padding: 14, gap: 4 },
  creditSummaryLabel: { fontSize: 10, fontWeight: "900", color: colors.muted, letterSpacing: 0.6 },
  creditSummaryValue: { fontSize: 22, fontWeight: "900", color: colors.navy },
  quickCustomer: { borderTopWidth: 1, paddingTop: 14, marginTop: 6, gap: 10 },
  installmentAmount:{fontSize:12,fontWeight:"900",color:colors.green},
});
