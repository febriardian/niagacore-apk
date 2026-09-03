import {
  archiveBusinessRecord,
  listBusinessRecords,
  listLocalProducts,
  listSales,
  requestRefund,
  salePaymentStatusLabel,
  saveBusinessRecord,
  transitionBusinessRecord,
  type BusinessRecord,
  type LocalProduct,
  type RecordKind,
  type SaleHistoryItem,
} from "@/lib/remote-store";
import { canAccessModule, formatRupiah } from "@niagacore/domain";
import type { MutationEnvelope } from "@niagacore/contracts";
import * as Crypto from "expo-crypto";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";

import { createMutation } from "@/lib/mutations";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Header,
  ProductImage,
  Row,
  Screen,
  Sheet,
} from "@/ui/components";
import { colors, radius } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert, translateUi } from "@/ui/localized-text";
import { supabase } from "@/lib/supabase";
import { ReceiptOcrSheet, type ReceiptOcrResult } from "@/ui/receipt-ocr-sheet";
import {isWorkflowModuleVisible} from "@/screens/module-visibility";
import {
  modules as workflowModules,
  transitionsFor,
  validateWorkflowRecord,
  type WorkflowField,
} from "@/screens/workflow-definitions";

type ModuleDefinition = {
  kind: RecordKind;
  title: string;
  description: string;
  icon: string;
  group: string;
  amount?: boolean;
  quantity?: boolean;
  due?: boolean;
};

function operationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const known: Record<string,string> = {
    fiscal_period_closed:"Periode akuntansi sudah ditutup. Buka kembali periode sebelum memposting transaksi.",
    owner_approval_required:"Tindakan ini hanya dapat dilakukan pemilik.",
    supervisor_approval_required:"Tindakan ini memerlukan persetujuan supervisor atau pemilik.",
    record_version_conflict:"Data berubah di perangkat lain. Sinkronkan lalu buka kembali data ini.",
    insufficient_stock:"Stok tidak mencukupi untuk menyelesaikan proses ini.",
    record_not_found:"Data tidak ditemukan atau sudah diarsipkan.",
  };
  return known[message] ?? message;
}
const modules: ModuleDefinition[] = [
  {
    kind: "customer",
    title: "Pelanggan",
    description: "Data pelanggan dan riwayat belanja",
    icon: "◎",
    group: "Relasi",
  },
  {
    kind: "supplier",
    title: "Pemasok",
    description: "Data pemasok dan transaksi pembelian",
    icon: "◇",
    group: "Relasi",
  },
  {
    kind: "purchase_order",
    title: "Pesanan pembelian",
    description: "Buat dan pantau pesanan ke pemasok",
    icon: "▤",
    group: "Pembelian",
    amount: true,
    due: true,
  },
  {
    kind: "goods_receipt",
    title: "Penerimaan barang",
    description: "Barang datang dan stok masuk",
    icon: "⇣",
    group: "Pembelian",
    amount: true,
    quantity: true,
  },
  {
    kind: "supplier_bill",
    title: "Tagihan pemasok",
    description: "Catat tagihan dan tanggal pembayaran",
    icon: "▧",
    group: "Pembelian",
    amount: true,
    due: true,
  },
  {
    kind: "purchase_return",
    title: "Retur pembelian",
    description: "Barang dikembalikan ke pemasok",
    icon: "↶",
    group: "Pembelian",
    amount: true,
    quantity: true,
  },
  {
    kind: "payable",
    title: "Utang usaha",
    description: "Saldo dan pembayaran pemasok",
    icon: "−",
    group: "Keuangan",
    amount: true,
    due: true,
  },
  {
    kind: "receivable",
    title: "Piutang usaha",
    description: "Tagihan dan penerimaan pelanggan",
    icon: "＋",
    group: "Keuangan",
    amount: true,
    due: true,
  },
  {
    kind: "expense",
    title: "Pengeluaran",
    description: "Beban operasional dan bukti",
    icon: "↗",
    group: "Keuangan",
    amount: true,
  },
  {
    kind: "manual_journal",
    title: "Jurnal manual",
    description: "Catat transaksi akuntansi lainnya",
    icon: "≋",
    group: "Akuntansi",
    amount: true,
  },
  {
    kind: "fiscal_period",
    title: "Periode akuntansi",
    description: "Atur periode pencatatan laporan",
    icon: "▦",
    group: "Akuntansi",
    due: true,
  },
  {
    kind: "asset",
    title: "Aset tetap",
    description: "Nilai perolehan dan penyusutan",
    icon: "▰",
    group: "Akuntansi",
    amount: true,
    due: true,
  },
  {
    kind: "tax",
    title: "Pajak",
    description: "Atur jenis dan tarif pajak usaha",
    icon: "%",
    group: "Akuntansi",
    amount: true,
  },
  {
    kind: "stock_count",
    title: "Stok opname",
    description: "Cocokkan stok aplikasi dengan stok fisik",
    icon: "✓",
    group: "Persediaan",
    quantity: true,
  },
  {
    kind: "stock_transfer",
    title: "Transfer stok",
    description: "Perpindahan antargudang/cabang",
    icon: "⇄",
    group: "Persediaan",
    quantity: true,
  },
  {
    kind: "lot",
    title: "Batch & kedaluwarsa",
    description: "Lot, tanggal, dan kuantitas",
    icon: "⌁",
    group: "Persediaan",
    quantity: true,
    due: true,
  },
  {
    kind: "price_list",
    title: "Daftar harga",
    description: "Atur harga eceran, grosir, dan khusus",
    icon: "₨",
    group: "Katalog",
    amount: true,
    quantity: true,
  },
  {
    kind: "bundle",
    title: "Bundel produk",
    description: "Paket produk dan harga gabungan",
    icon: "◫",
    group: "Katalog",
    amount: true,
    quantity: true,
  },
  {
    kind: "recipe",
    title: "Resep / BOM",
    description: "Atur bahan baku dan takaran menu",
    icon: "⌘",
    group: "F&B",
    quantity: true,
  },
  {
    kind: "modifier",
    title: "Modifier",
    description: "Tambahan dan pilihan menu",
    icon: "＋",
    group: "F&B",
    amount: true,
  },
  {
    kind: "dining_table",
    title: "Meja",
    description: "Kapasitas dan status meja",
    icon: "□",
    group: "F&B",
    quantity: true,
  },
  {
    kind: "kitchen_order",
    title: "Pesanan dapur",
    description: "Antrean dan status penyajian",
    icon: "≡",
    group: "F&B",
  },
  {
    kind: "service",
    title: "Layanan",
    description: "Durasi, staf, dan harga jasa",
    icon: "◷",
    group: "Jasa",
    amount: true,
    quantity: true,
  },
  {
    kind: "appointment",
    title: "Jadwal layanan",
    description: "Pelanggan, waktu, dan status",
    icon: "◴",
    group: "Jasa",
    due: true,
  },
  {
    kind: "customer_segment",
    title: "Segmen pelanggan",
    description: "Kelompokkan pelanggan berdasarkan aktivitas",
    icon: "◉",
    group: "CRM",
  },
  {
    kind: "loyalty",
    title: "Loyalitas",
    description: "Poin, penyesuaian, dan persetujuan",
    icon: "★",
    group: "CRM",
    amount: true,
  },
  {
    kind: "staff",
    title: "Staf & akses",
    description: "Atur peran dan akses setiap cabang",
    icon: "♙",
    group: "Pengaturan",
  },
  {
    kind: "device",
    title: "Perangkat",
    description: "Registrasi dan pencabutan perangkat",
    icon: "▯",
    group: "Pengaturan",
  },
  {
    kind: "hardware",
    title: "Perangkat kasir",
    description: "Printer, scanner, laci, timbangan",
    icon: "⌑",
    group: "Pengaturan",
  },
  {
    kind: "notification",
    title: "Notifikasi",
    description: "Peringatan operasional dan status",
    icon: "●",
    group: "Pengaturan",
  },
];

export function OperationsScreen({
  workspace,
  onChanged,
  onOpenSettings,
  onOpenWallet,
  onOpenReceipts,
  onOpenStaff,
  onOpenApprovals,
  onOpenDevices,
  onOpenPeripherals,
  onOpenWorkspaces,
  onOpenKnowledge,
  onOpenOperationalHealth,
  onOpenNiaGovernance,
}: {
  workspace: ActiveWorkspace;
  onChanged: () => Promise<void>;
  onOpenSettings: () => void;
  onOpenWallet: () => void;
  onOpenReceipts: () => void;
  onOpenStaff: () => void;
  onOpenApprovals: () => void;
  onOpenDevices: () => void;
  onOpenPeripherals: () => void;
  onOpenWorkspaces: () => void;
  onOpenKnowledge: () => void;
  onOpenOperationalHealth: () => void;
  onOpenNiaGovernance: () => void;
}) {
  const theme=useAppTheme();
  const [active, setActive] = React.useState<ModuleDefinition | null>(null);
  const [sales, setSales] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [groupFilter,setGroupFilter]=React.useState("Pembelian");
  const visibleModules = modules
    .filter((m) => !["staff", "device", "hardware"].includes(m.kind))
    .filter((m)=>isWorkflowModuleVisible(workspace.modules,m.kind,m.group))
    .filter((m) => canAccessModule(workspace.role, m.kind));
  const normalizedQuery = query.trim().toLocaleLowerCase("id-ID");
  const availableGroups=[...new Set(visibleModules.map((module)=>module.group))];
  const activeGroup=availableGroups.includes(groupFilter)?groupFilter:(availableGroups[0]??"");
  const filteredModules = normalizedQuery
    ? visibleModules.filter((module) =>
        `${module.title} ${module.description} ${module.group}`
          .toLocaleLowerCase("id-ID")
          .includes(normalizedQuery),
      )
    : visibleModules.filter((module)=>module.group===activeGroup);
  const groups = [...new Set(filteredModules.map((m) => m.group))];
  return (
    <Screen>
      <Header
        title="Pusat usaha"
        subtitle="Pilih pekerjaan, lalu ikuti alur yang sesuai"
      />
      <View style={[s.searchBox,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
        <Text style={s.searchIcon}>⌕</Text>
        <TextInput
          accessibilityLabel="Cari fitur"
          onChangeText={setQuery}
          placeholder="Cari pembelian, stok, jurnal, pelanggan..."
          placeholderTextColor={theme.colors.muted}
          style={[s.searchInput,{color:theme.colors.ink}]}
          value={query}
        />
      </View>
      <View style={s.quickGrid}>
        <QuickAction icon="↺" title="Riwayat transaksi" detail="Filter, omzet, retur, visualisasi, dan struk" onPress={onOpenReceipts} />
        {workspace.role === "owner" && (
          <QuickAction icon="Rp" title="Saldo usaha" detail="Saldo dan penarikan" onPress={onOpenWallet} />
        )}
        {["owner", "business_manager"].includes(workspace.role) && (
          <QuickAction icon="TM" title="Staf & akses" detail="Peran, cabang, dan status" onPress={onOpenStaff} />
        )}
        {["owner", "business_manager"].includes(workspace.role) && (
          <QuickAction icon="US" title="Usaha & cabang" detail="Kelola seluruh ruang kerja" onPress={onOpenWorkspaces} />
        )}
        {["owner", "business_manager"].includes(workspace.role) && (
          <QuickAction icon="▯" title="Perangkat login" detail="Otomatis tercatat saat masuk" onPress={onOpenDevices} />
        )}
        {workspace.role === "owner" && (
          <QuickAction icon="＋" title="Status sistem" detail="Koneksi dan pembayaran" onPress={onOpenOperationalHealth} />
        )}
        {["owner", "business_manager"].includes(workspace.role) && (
          <QuickAction icon="N" title="Kinerja NIA" detail="Kualitas analisis dan proses otomatis" onPress={onOpenNiaGovernance} />
        )}
        <QuickAction icon="⌑" title="Printer & scanner" detail="Tes koneksi perangkat kasir" onPress={onOpenPeripherals} />
        {["owner", "business_manager", "branch_manager", "supervisor"].includes(workspace.role) && (
          <QuickAction icon="✓" title="Persetujuan" detail="Retur, diskon, stok, PO, dan jurnal" onPress={onOpenApprovals} />
        )}
        {["owner", "business_manager", "branch_manager"].includes(workspace.role) && (
          <QuickAction icon="N" title="Basis pengetahuan NIA" detail="Panduan, kebijakan, dan jawaban usaha" onPress={onOpenKnowledge} />
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.groupTabs}>
        {availableGroups.map((group)=><Pressable key={group} onPress={()=>setGroupFilter(group)} style={[s.groupTab,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line},activeGroup===group&&s.groupTabActive]}><Text style={[s.groupTabText,activeGroup===group&&s.groupTabTextActive]}>{group}</Text></Pressable>)}
      </ScrollView>
      {groups.map((group) => (
        <View key={group} style={s.group}>
          <Text style={s.groupTitle}>{group.toUpperCase()}</Text>
          <View style={s.moduleList}>
            {filteredModules
              .filter((m) => m.group === group)
              .map((m) => (
                <Pressable
                  key={m.kind}
                  onPress={() => setActive(m)}
                  style={({ pressed }) => [s.moduleRow,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}, pressed && s.pressed]}
                >
                  <View style={[s.moduleIcon,{backgroundColor:theme.colors.blueSoft}]}>
                    <Text style={s.moduleIconText}>{m.icon}</Text>
                  </View>
                  <View style={s.moduleCopy}>
                    <Text style={s.moduleTitle}>{m.title}</Text>
                    <Text numberOfLines={2} style={s.moduleDetail}>{m.description}</Text>
                  </View>
                  <Text style={s.moduleArrow}>›</Text>
                </Pressable>
              ))}
          </View>
        </View>
      ))}
      <Button
        variant="outline"
        title={workspace.role==="cashier"?"Pengaturan akun & perangkat":"Pengaturan usaha & akuntansi"}
        onPress={onOpenSettings}
      />
      {active && (
        <RecordsSheet
          module={active}
          workspace={workspace}
          onChanged={onChanged}
          close={() => setActive(null)}
        />
      )}
      <SalesSheet
        visible={sales}
        close={() => setSales(false)}
        workspace={workspace}
        onChanged={onChanged}
      />
    </Screen>
  );
}

function QuickAction({icon,title,detail,onPress}:{icon:string;title:string;detail:string;onPress:()=>void}) {
  const theme=useAppTheme();
  return <Pressable onPress={onPress} style={({pressed})=>[s.quickAction,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line},pressed&&s.pressed]}>
    <View style={[s.quickIcon,{backgroundColor:theme.colors.blueSoft}]}><Text style={s.quickIconText}>{icon}</Text></View>
    <Text style={s.quickTitle}>{title}</Text>
    <Text style={s.quickDetail}>{detail}</Text>
  </Pressable>;
}

function RecordsSheet({
  module,
  workspace,
  onChanged,
  close,
}: {
  module: ModuleDefinition;
  workspace: ActiveWorkspace;
  onChanged: () => Promise<void>;
  close: () => void;
}) {
  const db = useRemoteStore();
  const [records, setRecords] = React.useState<BusinessRecord[]>([]);
  const [editing, setEditing] = React.useState<
    BusinessRecord | null | undefined
  >(undefined);
  const load = React.useCallback(
    async () =>
      setRecords(await listBusinessRecords(db, workspace, module.kind)),
    [db, module.kind, workspace],
  );
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const changed = async () => {
    await load();
    await onChanged();
  };
  return (
    <Sheet visible title={module.title} onClose={close}>
      <Text style={s.intro}>{module.description}. Data yang disimpan akan tersedia di perangkat lain sesuai akses pengguna.</Text>
      <Button
        title={`＋ Tambah ${module.title.toLowerCase()}`}
        onPress={() => setEditing(null)}
      />
      {records.length === 0 ? (
        <EmptyState
          title={`Belum ada ${module.title.toLowerCase()}`}
          detail="Buat data pertama untuk mulai menggunakan modul ini."
        />
      ) : (
        records.map((r) => (
          <Row
            key={r.id}
            title={r.title}
            detail={[
              r.code,
              r.subtitle,
              r.amountMinor ? formatRupiah(r.amountMinor) : null,
              r.quantity ? `${r.quantity} unit` : null,
              r.dueAt ? `Jatuh tempo ${r.dueAt}` : null,
            ]
              .filter(Boolean)
              .join(" • ")}
            right={
              <Badge
                text={r.status}
                tone={
                  r.status === "paid" ||
                  r.status === "posted" ||
                  r.status === "active"
                    ? "green"
                    : "amber"
                }
              />
            }
            onPress={() => setEditing(r)}
          />
        ))
      )}
      <RecordEditor
        visible={editing !== undefined}
        module={module}
        record={editing ?? null}
        workspace={workspace}
        close={() => setEditing(undefined)}
        saved={async () => {
          setEditing(undefined);
          await changed();
        }}
      />
    </Sheet>
  );
}

function RecordEditor({
  visible,
  module,
  record,
  workspace,
  close,
  saved,
}: {
  visible: boolean;
  module: ModuleDefinition;
  record: BusinessRecord | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const workflow = workflowModules.find(
    (definition) => definition.kind === module.kind,
  )!;
  const coreLabels = labelsFor(module.kind);
  const [title, setTitle] = React.useState("");
  const [code, setCode] = React.useState("");
  const [subtitle, setSubtitle] = React.useState("");
  const [amount, setAmount] = React.useState("");
  const [quantity, setQuantity] = React.useState("");
  const [due, setDue] = React.useState("");
  const [status, setStatus] = React.useState(workflow.initialStatus);
  const [metadata, setMetadata] = React.useState<Record<string, unknown>>({});
  const [relatedOptions, setRelatedOptions] = React.useState<Record<string, { value:string; label:string }[]>>({});
  const [products, setProducts] = React.useState<LocalProduct[]>([]);
  const [ocrOpen, setOcrOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const supportsOcr = ["purchase_order", "goods_receipt", "supplier_bill", "expense", "purchase_return"].includes(module.kind);
  const applyOcr = (result: ReceiptOcrResult) => {
    if (result.amountMinor) setAmount(String(result.amountMinor));
    if (result.date && workflow.dueLabel) setDue(result.date);
    if (result.reference && !code) setCode(result.reference);
    setMetadata((current) => ({ ...current, ocrRawText: result.rawText, ocrCapturedAt: new Date().toISOString(), attachment: current.attachment || "OCR on-device" }));
  };
  React.useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      setTitle(record?.title ?? "");
      setCode(record?.code ?? "");
      setSubtitle(record?.subtitle ?? "");
      setAmount(record?.amountMinor ? String(record.amountMinor) : "");
      setQuantity(record?.quantity ? String(record.quantity) : "");
      setDue(record?.dueAt ?? "");
      setStatus(record?.status ?? workflow.initialStatus);
      setMetadata(record?.metadata ?? {});
    }, 0);
    return () => clearTimeout(timer);
  }, [record, visible, workflow.initialStatus]);
  React.useEffect(() => {
    if (!visible) return;
    const loadOptions = async () => {
      const keys = new Set(workflow.fields.map((field) => field.key));
      const next: Record<string, { value:string; label:string }[]> = {};
      if (keys.has("supplierId")) next.supplierId = (await listBusinessRecords(db, workspace, "supplier")).map((item) => ({ value:item.id, label:item.title }));
      if (keys.has("customerId")) next.customerId = (await listBusinessRecords(db, workspace, "customer")).map((item) => ({ value:item.id, label:item.title }));
      if (keys.has("purchaseOrderId")) next.purchaseOrderId = (await listBusinessRecords(db, workspace, "purchase_order")).map((item) => ({ value:item.id, label:item.code || item.title }));
      if (keys.has("goodsReceiptId")) next.goodsReceiptId = (await listBusinessRecords(db, workspace, "goods_receipt")).map((item) => ({ value:item.id, label:item.code || item.title }));
      if (keys.has("serviceId")) next.serviceId = (await listBusinessRecords(db, workspace, "service")).map((item) => ({ value:item.id, label:item.title }));
      if (keys.has("customerSegmentId")) next.customerSegmentId = (await listBusinessRecords(db, workspace, "customer_segment")).map((item) => ({ value:item.id, label:item.title }));
      if (["productId","outputProductId"].some((key) => keys.has(key))) {
        const products = await listLocalProducts(db, workspace.tenantId, workspace.branchId);
        const options = products.map((item) => ({ value:item.id, label:item.name }));
        next.productId = options;
        next.outputProductId = options;
      }
      if (["purchase_order", "bundle", "recipe"].includes(module.kind)) {
        setProducts(await listLocalProducts(db, workspace.tenantId, workspace.branchId));
      }
      if (["sourceBranchId","destinationBranchId","warehouseId"].some((key) => keys.has(key)) && supabase) {
        const result = await supabase.from("branches").select("id,name").eq("tenant_id",workspace.tenantId).eq("active",true).order("name");
        if (!result.error) {
          const options = (result.data ?? []).map((item) => ({ value:String(item.id), label:String(item.name) }));
          next.sourceBranchId = options; next.destinationBranchId = options; next.warehouseId = options;
        }
      }
      setRelatedOptions(next);
    };
    const timer = setTimeout(() => void loadOptions(), 0);
    return () => clearTimeout(timer);
  }, [db, module.kind, visible, workflow.fields, workspace]);
  const save = async () => {
    const id = record?.id ?? Crypto.randomUUID();
    const amountMinor = Math.round(Number(amount) || 0),
      qty = Number(quantity) || 0;
    const validationError = validateWorkflowRecord(workflow, {
      title,
      amountMinor,
      quantity: qty,
      dueAt: due.trim() || null,
      metadata,
    });
    if (validationError) {
      localizedAlert(translateUi("Periksa formulir"), translateUi(validationError));
      return;
    }
    const payload = {
      kind: module.kind,
      code: code.trim() || null,
      title: title.trim(),
      subtitle: subtitle.trim() || null,
      status,
      amountMinor,
      quantity: qty,
      dueAt: due.trim() || null,
      metadata,
    };
    setBusy(true);
    try {
      await saveBusinessRecord(db, {
        id,
        ...payload,
        context: workspace,
        metadata,
        version: record?.version ?? 0,
        mutation: await createMutation(workspace,module.kind as MutationEnvelope["aggregateType"],id,record ? "update" : "create",payload,record?.version ?? null),
      });
      await saved();
    } catch(error) { localizedAlert("Gagal menyimpan",operationError(error)); }
    finally { setBusy(false); }
  };
  const transition = async (toStatus: string) => {
    if (!record) return;
    setBusy(true);
    try {
      await transitionBusinessRecord(db, {
        record,toStatus,context:workspace,
        mutation:await createMutation(workspace,module.kind as MutationEnvelope["aggregateType"],record.id,"update",{kind:record.kind,code:record.code,title:record.title,subtitle:record.subtitle,status:toStatus,amountMinor:record.amountMinor,quantity:record.quantity,dueAt:record.dueAt,metadata},record.version),
      });
      await saved();
    } catch(error) { localizedAlert("Proses gagal",operationError(error)); }
    finally { setBusy(false); }
  };
  const archive = () =>
    record &&
    localizedAlert("Arsipkan data", "Riwayat dan referensi tetap dipertahankan.", [
      { text: "Batal", style: "cancel" },
      {
        text: "Arsipkan",
        style: "destructive",
        onPress: () => void (async () =>
          archiveBusinessRecord(
            db,
            record.id,
            await createMutation(
              workspace,
              module.kind as MutationEnvelope["aggregateType"],
              record.id,
              "archive",
              { id: record.id },
              record.version,
            ),
          ).then(saved))(),
      },
    ]);
  return (
    <Sheet
      visible={visible}
      title={record ? `Edit ${module.title}` : `Tambah ${module.title}`}
      onClose={close}
    >
      <View style={s.formIntro}>
        <View style={[s.formMarker, { backgroundColor: formPresentation(module.kind).color }]} />
        <View style={s.formIntroCopy}>
          <Text style={s.formEyebrow}>{module.group.toUpperCase()}</Text>
          <Text style={s.formDescription}>{formPresentation(module.kind).instruction}</Text>
        </View>
      </View>
      <Text style={s.formSection}>{formPresentation(module.kind).primarySection}</Text>
      <Field label={coreLabels.title} value={title} onChangeText={setTitle} />
      <Field label={coreLabels.code} value={code} onChangeText={setCode} />
      <Field
        label={coreLabels.subtitle}
        value={subtitle}
        onChangeText={setSubtitle}
        multiline
      />
      {supportsOcr && (
        <Button variant="outline" title="▣ Pindai nota / invoice (OCR)" onPress={() => setOcrOpen(true)} />
      )}
      {module.kind === "purchase_order" && (
        <LineItemsEditor
          products={products}
          value={Array.isArray(metadata.items) ? metadata.items as PurchaseLine[] : []}
          onChange={(items) => {
            setMetadata((current) => ({ ...current, items }));
            setAmount(String(items.reduce((total, item) => total + item.quantity * item.unitCostMinor, 0)));
          }}
        />
      )}
      {workflow.amountLabel && !["purchase_order","manual_journal"].includes(module.kind) && (
        <Field
          label={workflow.amountLabel}
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
        />
      )}
      {module.kind === "manual_journal" && (
        <JournalLinesEditor
          value={Array.isArray(metadata.journalLines) ? metadata.journalLines as JournalDraftLine[] : []}
          onChange={(journalLines) => {
            setMetadata((current)=>({...current,journalLines}));
            setAmount(String(journalLines.reduce((sum,line)=>sum+line.debitMinor,0)));
          }}
        />
      )}
      {["bundle","recipe"].includes(module.kind) && (
        <ComponentEditor
          products={products}
          label={module.kind === "recipe" ? "BAHAN RESEP" : "KOMPONEN BUNDEL"}
          value={Array.isArray(metadata[module.kind === "recipe" ? "ingredients" : "components"])
            ? metadata[module.kind === "recipe" ? "ingredients" : "components"] as ComponentLine[] : []}
          onChange={(value)=>setMetadata((current)=>({...current,[module.kind === "recipe" ? "ingredients" : "components"]:value}))}
        />
      )}
      {workflow.quantityLabel && (
        <Field
          label={workflow.quantityLabel}
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="numeric"
        />
      )}
      {workflow.dueLabel && (
        <Field
          label={`${workflow.dueLabel} (YYYY-MM-DD)`}
          value={due}
          onChangeText={setDue}
        />
      )}
      {workflow.fields.length > 0 && <Text style={s.formSection}>{formPresentation(module.kind).detailSection}</Text>}
      {workflow.fields.filter((field) => !(
        (module.kind === "purchase_order" && field.key === "items") ||
        (module.kind === "manual_journal" && field.key === "journalLines") ||
        (module.kind === "bundle" && field.key === "components") ||
        (module.kind === "recipe" && field.key === "ingredients")
      )).map((field) => (
        <WorkflowInput
          key={field.key}
          field={field}
          value={metadata[field.key]}
          relatedOptions={relatedOptions[field.key]}
          onChange={(value) =>
            setMetadata((current) => ({ ...current, [field.key]: value }))
          }
        />
      ))}
      <View style={s.statusPanel}>
        <Text style={s.statusLabel}>STATUS WORKFLOW</Text>
        <Badge text={status} tone={status === "posted" || status === "active" || status === "paid" || status === "completed" ? "green" : "amber"} />
      </View>
      <Button disabled={busy} title={busy?"Menyimpan...":"Simpan"} onPress={() => void save()} />
      {record &&
        transitionsFor(workflow, status, workspace.role).map((item) => (
          <Button
            key={`${status}:${item.to}`}
            variant="outline"
            disabled={busy}
            title={item.label}
            onPress={() => {
              const run = () => void transition(item.to);
              if (item.confirm)
                localizedAlert(item.label, item.confirm, [
                  { text: "Batal", style: "cancel" },
                  { text: "Lanjutkan", onPress: run },
                ]);
              else run();
            }}
          />
        ))}
      {record && <Button variant="danger" title="Arsipkan" onPress={archive} />}
      <ReceiptOcrSheet visible={ocrOpen} onClose={() => setOcrOpen(false)} onApply={applyOcr} />
    </Sheet>
  );
}

type PurchaseLine = { productId: string; sku: string; name: string; quantity: number; unitCostMinor: number };
type ComponentLine = { productId:string; sku:string; name:string; quantity:number; unit:string };
type JournalDraftLine = { accountCode:string; debitMinor:number; creditMinor:number; description?:string };

function LineItemsEditor({products,value,onChange}:{products:LocalProduct[];value:PurchaseLine[];onChange:(items:PurchaseLine[])=>void}) {
  const add = (product: LocalProduct) => {
    if (value.some((item) => item.productId === product.id)) return;
    onChange([...value, { productId: product.id, sku: product.sku, name: product.name, quantity: 1, unitCostMinor: product.costMinor || product.priceMinor }]);
  };
  const update = (index:number, patch:Partial<PurchaseLine>) => onChange(value.map((item,itemIndex)=>itemIndex===index?{...item,...patch}:item));
  return <View style={s.lineEditor}>
    <View style={s.lineHeader}><Text style={s.lineTitle}>ITEM PESANAN</Text><Badge text={`${value.length} item`} tone="blue"/></View>
    {products.length === 0 ? <Text style={s.lineHelp}>Tambahkan produk terlebih dahulu sebelum membuat pesanan pembelian.</Text> : (
      <View style={s.productPicker}>{products.filter((product)=>!value.some((item)=>item.productId===product.id)).slice(0,20).map((product)=><Pressable key={product.id} onPress={()=>add(product)} style={s.productChoice}><ProductImage uri={product.imageUri} name={product.name} size={26}/><Text numberOfLines={1} style={s.productChoiceText}>{product.name}</Text><Text style={s.productChoicePlus}>＋</Text></Pressable>)}</View>
    )}
    {value.map((item,index)=><View key={item.productId} style={s.purchaseLine}>
      <View style={s.purchaseLineTop}><View style={s.formIntroCopy}><Text style={s.purchaseName}>{item.name}</Text><Text style={s.purchaseSku}>{item.sku}</Text></View><Pressable hitSlop={8} onPress={()=>onChange(value.filter((_,itemIndex)=>itemIndex!==index))}><Text style={s.removeLine}>Hapus</Text></Pressable></View>
      <View style={s.purchaseInputs}><View style={s.purchaseInput}><Field label="Jumlah" value={String(item.quantity)} keyboardType="numeric" onChangeText={(next)=>update(index,{quantity:Math.max(0,Number(next)||0)})}/></View><View style={s.purchaseInput}><Field label="Harga satuan" value={String(item.unitCostMinor)} keyboardType="numeric" onChangeText={(next)=>update(index,{unitCostMinor:Math.max(0,Math.round(Number(next)||0))})}/></View></View>
      <Text style={s.purchaseSubtotal}>{formatRupiah(item.quantity*item.unitCostMinor)}</Text>
    </View>)}
    {value.length > 0 && <View style={s.lineTotal}><Text style={s.lineTotalLabel}>Total pesanan</Text><Text style={s.lineTotalValue}>{formatRupiah(value.reduce((total,item)=>total+item.quantity*item.unitCostMinor,0))}</Text></View>}
  </View>;
}

function ComponentEditor({products,label,value,onChange}:{products:LocalProduct[];label:string;value:ComponentLine[];onChange:(value:ComponentLine[])=>void}) {
  const add=(product:LocalProduct)=>{
    if(value.some((line)=>line.productId===product.id))return;
    onChange([...value,{productId:product.id,sku:product.sku,name:product.name,quantity:1,unit:product.unit}]);
  };
  return <View style={s.lineEditor}>
    <View style={s.lineHeader}><Text style={s.lineTitle}>{label}</Text><Badge text={`${value.length} item`} tone={value.length?"green":"amber"}/></View>
    <View style={s.productPicker}>{products.filter((product)=>!value.some((line)=>line.productId===product.id)).slice(0,20).map((product)=><Pressable key={product.id} onPress={()=>add(product)} style={s.productChoice}><ProductImage uri={product.imageUri} name={product.name} size={26}/><Text numberOfLines={1} style={s.productChoiceText}>{product.name}</Text><Text style={s.productChoicePlus}>＋</Text></Pressable>)}</View>
    {value.map((line,index)=><View key={line.productId} style={s.purchaseLine}>
      <View style={s.purchaseLineTop}><View style={s.formIntroCopy}><Text style={s.purchaseName}>{line.name}</Text><Text style={s.purchaseSku}>{line.sku} • {line.unit}</Text></View><Pressable onPress={()=>onChange(value.filter((_,i)=>i!==index))}><Text style={s.removeLine}>Hapus</Text></Pressable></View>
      <Field label="Jumlah" value={String(line.quantity)} keyboardType="numeric" onChangeText={(next)=>onChange(value.map((item,i)=>i===index?{...item,quantity:Math.max(0,Number(next)||0)}:item))}/>
    </View>)}
    {!products.length?<Text style={s.lineHelp}>Tambahkan produk terlebih dahulu.</Text>:null}
  </View>;
}

const journalAccounts = [
  ["1101","Kas"],["1102","Bank"],["1201","Piutang usaha"],["1301","Persediaan"],
  ["1501","Aset tetap"],["1601","Akumulasi penyusutan"],["2101","Utang usaha"],
  ["2103","Pajak keluaran"],["4101","Pendapatan"],["5101","HPP"],["6101","Beban operasional"],
] as const;

function JournalLinesEditor({value,onChange}:{value:JournalDraftLine[];onChange:(value:JournalDraftLine[])=>void}) {
  const lines=value.length?value:[{accountCode:"",debitMinor:0,creditMinor:0},{accountCode:"",debitMinor:0,creditMinor:0}];
  const update=(index:number,patch:Partial<JournalDraftLine>)=>onChange(lines.map((line,i)=>i===index?{...line,...patch}:line));
  const debit=lines.reduce((sum,line)=>sum+line.debitMinor,0),credit=lines.reduce((sum,line)=>sum+line.creditMinor,0);
  return <View style={s.lineEditor}>
    <View style={s.lineHeader}><Text style={s.lineTitle}>BARIS JURNAL</Text><Badge text={debit>0&&debit===credit?"Seimbang":"Belum seimbang"} tone={debit>0&&debit===credit?"green":"red"}/></View>
    {lines.map((line,index)=><View key={index} style={s.purchaseLine}>
      <Text style={s.purchaseName}>Baris {index+1}</Text>
      <View style={s.choiceWrap}>{journalAccounts.map(([code,name])=><Pressable key={code} onPress={()=>update(index,{accountCode:code})} style={[s.choice,line.accountCode===code&&s.choiceActive]}><Text style={[s.choiceText,line.accountCode===code&&s.choiceTextActive]}>{code} {name}</Text></Pressable>)}</View>
      <View style={s.purchaseInputs}><View style={s.purchaseInput}><Field label="Debit" value={line.debitMinor?String(line.debitMinor):""} keyboardType="numeric" onChangeText={(next)=>update(index,{debitMinor:Math.max(0,Math.round(Number(next)||0)),creditMinor:0})}/></View><View style={s.purchaseInput}><Field label="Kredit" value={line.creditMinor?String(line.creditMinor):""} keyboardType="numeric" onChangeText={(next)=>update(index,{creditMinor:Math.max(0,Math.round(Number(next)||0)),debitMinor:0})}/></View></View>
      {lines.length>2?<Pressable onPress={()=>onChange(lines.filter((_,i)=>i!==index))}><Text style={s.removeLine}>Hapus baris</Text></Pressable>:null}
    </View>)}
    <Button variant="outline" title="＋ Tambah baris jurnal" onPress={()=>onChange([...lines,{accountCode:"",debitMinor:0,creditMinor:0}])}/>
    <View style={s.lineTotal}><Text style={s.lineTotalLabel}>Debit {formatRupiah(debit)}</Text><Text style={s.lineTotalValue}>Kredit {formatRupiah(credit)}</Text></View>
  </View>;
}

function labelsFor(kind: RecordKind) {
  const labels: Partial<Record<RecordKind,{title:string;code:string;subtitle:string}>>={
    customer:{title:"Nama pelanggan",code:"Kode pelanggan",subtitle:"Catatan pelanggan"},
    supplier:{title:"Nama pemasok",code:"Kode pemasok",subtitle:"Produk atau layanan utama"},
    purchase_order:{title:"Nama pesanan",code:"Nomor PO",subtitle:"Catatan pembelian"},
    goods_receipt:{title:"Nama penerimaan",code:"Nomor penerimaan",subtitle:"Kondisi barang diterima"},
    supplier_bill:{title:"Nama tagihan",code:"Nomor invoice",subtitle:"Catatan tagihan"},
    purchase_return:{title:"Referensi retur",code:"Nomor retur",subtitle:"Kondisi barang yang dikembalikan"},
    payable:{title:"Nama pemasok / tagihan",code:"Nomor utang",subtitle:"Catatan pembayaran"},
    receivable:{title:"Nama pelanggan / tagihan",code:"Nomor piutang",subtitle:"Catatan penagihan"},
    expense:{title:"Nama pengeluaran",code:"Nomor bukti",subtitle:"Keperluan pengeluaran"},
    manual_journal:{title:"Memo jurnal",code:"Nomor jurnal",subtitle:"Dasar pencatatan"},
    fiscal_period:{title:"Nama periode",code:"Kode periode",subtitle:"Catatan penutupan"},
    asset:{title:"Nama aset",code:"Nomor aset",subtitle:"Lokasi dan kondisi aset"},
    tax:{title:"Nama kebijakan pajak",code:"Kode pajak",subtitle:"Keterangan penggunaan"},
    stock_count:{title:"Nama sesi opname",code:"Nomor opname",subtitle:"Lokasi dan petugas hitung"},
    stock_transfer:{title:"Referensi transfer",code:"Nomor transfer",subtitle:"Tujuan dan catatan pengiriman"},
    lot:{title:"Nama produk / batch",code:"Nomor lot",subtitle:"Lokasi penyimpanan"},
    price_list:{title:"Nama daftar harga",code:"Kode harga",subtitle:"Segmen pelanggan dan wilayah"},
    bundle:{title:"Nama bundel",code:"SKU bundel",subtitle:"Deskripsi paket"},
    recipe:{title:"Nama resep / BOM",code:"Kode resep",subtitle:"Hasil produksi"},
    modifier:{title:"Nama pilihan tambahan",code:"Kode modifier",subtitle:"Kelompok menu"},
    service:{title:"Nama layanan",code:"Kode layanan",subtitle:"Deskripsi layanan"},
    appointment:{title:"Nama pelanggan / jadwal",code:"Nomor booking",subtitle:"Catatan layanan"},
    dining_table:{title:"Nama / nomor meja",code:"Kode meja",subtitle:"Area meja"},
    kitchen_order:{title:"Nama pesanan",code:"Nomor antrean",subtitle:"Catatan dapur"},
    customer_segment:{title:"Nama segmen",code:"Kode segmen",subtitle:"Kriteria pelanggan"},
    loyalty:{title:"Nama program",code:"Kode program",subtitle:"Aturan perolehan dan penukaran"},
    device:{title:"Nama perangkat",code:"ID perangkat",subtitle:"Lokasi penggunaan"},
    hardware:{title:"Nama perangkat kasir",code:"Kode aset",subtitle:"Catatan koneksi"},
    notification:{title:"Judul notifikasi",code:"Kode aturan",subtitle:"Pesan yang ditampilkan"},
  };
  const fallback = workflowModules.find((item) => item.kind === kind);
  return labels[kind]??{
    title:`Nama ${fallback?.title.toLowerCase() ?? "data"}`,
    code:`Kode ${fallback?.title.toLowerCase() ?? "data"}`,
    subtitle:`Catatan ${fallback?.title.toLowerCase() ?? "data"}`,
  };
}

function formPresentation(kind: RecordKind) {
  if (["customer", "supplier", "customer_segment", "loyalty"].includes(kind))
    return { color: colors.blue2, instruction: "Identitas, kontak, dan hubungan usaha dikelola dalam satu profil.", primarySection: "PROFIL", detailSection: "KONTAK & KEBIJAKAN" };
  if (["purchase_order", "goods_receipt", "supplier_bill", "purchase_return"].includes(kind))
    return { color: "#314A86", instruction: "Dokumen pembelian memiliki nomor, pihak terkait, nilai, dan jejak persetujuan.", primarySection: "DOKUMEN PEMBELIAN", detailSection: "ITEM & PEMASOK" };
  if (["payable", "receivable", "expense"].includes(kind))
    return { color: "#155B61", instruction: "Nominal, sumber dana, jatuh tempo, dan status pembayaran dicatat terpisah.", primarySection: "RINGKASAN KEUANGAN", detailSection: "PEMBAYARAN" };
  if (["manual_journal", "fiscal_period", "asset", "tax"].includes(kind))
    return { color: "#3A4167", instruction: "Kontrol akuntansi memerlukan data lengkap dan persetujuan sesuai peran.", primarySection: "DOKUMEN AKUNTANSI", detailSection: "AKUN & KEBIJAKAN" };
  if (["stock_count", "stock_transfer", "lot"].includes(kind))
    return { color: "#1A5A49", instruction: "Produk, lokasi, jumlah, dan alasan perubahan stok wajib dapat ditelusuri.", primarySection: "PERGERAKAN STOK", detailSection: "PRODUK & LOKASI" };
  if (["price_list", "bundle", "recipe", "modifier"].includes(kind))
    return { color: "#55408B", instruction: "Atur komposisi katalog dan harga tanpa mengubah data transaksi lama.", primarySection: "KATALOG", detailSection: "KOMPONEN & HARGA" };
  if (["service", "appointment", "dining_table", "kitchen_order"].includes(kind))
    return { color: "#185889", instruction: "Jadwal, kapasitas, petugas, dan status operasional dikelola dari alur ini.", primarySection: "LAYANAN", detailSection: "JADWAL & OPERASI" };
  return { color: colors.navy, instruction: "Lengkapi konfigurasi dan status untuk mengaktifkan fitur ini.", primarySection: "INFORMASI", detailSection: "KONFIGURASI" };
}

function WorkflowInput({
  field,
  value,
  relatedOptions,
  onChange,
}: {
  field: WorkflowField;
  value: unknown;
  relatedOptions?: { value:string; label:string }[];
  onChange: (value: unknown) => void;
}) {
  if (relatedOptions?.length)
    return <View style={s.choiceField}><Text style={s.booleanLabel}>{field.label}{field.required?" *":""}</Text><View style={s.choiceWrap}>{relatedOptions.slice(0,30).map(option=><Pressable key={option.value} onPress={()=>onChange(option.value)} style={[s.choice,value===option.value&&s.choiceActive]}><Text style={[s.choiceText,value===option.value&&s.choiceTextActive]}>{option.label}</Text></Pressable>)}</View></View>;
  if (field.type === "boolean")
    return (
      <View style={s.booleanField}>
        <View style={s.booleanCopy}>
          <Text style={s.booleanLabel}>{field.label}</Text>
          {field.help ? <Text style={s.booleanHelp}>{field.help}</Text> : null}
        </View>
        <Switch value={Boolean(value)} onValueChange={onChange} />
      </View>
    );
  if (field.type === "choice")
    return (
      <View style={s.choiceField}>
        <Text style={s.booleanLabel}>{field.label}</Text>
        <View style={s.choiceWrap}>
          {field.options?.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              style={[
                s.choice,
                value === option.value && s.choiceActive,
              ]}
            >
              <Text
                style={[
                  s.choiceText,
                  value === option.value && s.choiceTextActive,
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  return (
    <Field
      label={`${field.label}${field.required ? " *" : ""}`}
      value={value === undefined || value === null ? "" : String(value)}
      onChangeText={(next) =>
        onChange(field.type === "number" ? (next === "" ? "" : Number(next)) : next)
      }
      keyboardType={field.type === "number" ? "numeric" : "default"}
    />
  );
}

function SalesSheet({
  visible,
  close,
  workspace,
  onChanged,
}: {
  visible: boolean;
  close: () => void;
  workspace: ActiveWorkspace;
  onChanged: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const [sales, setSales] = React.useState<SaleHistoryItem[]>([]);
  const [selected, setSelected] = React.useState<SaleHistoryItem | null>(null);
  const load = React.useCallback(
    async () =>
      setSales(await listSales(
        db,
        workspace.tenantId,
        workspace.branchId,
        100,
      )),
    [db, workspace],
  );
  React.useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load, visible]);
  return (
    <Sheet visible={visible} title="Riwayat transaksi" onClose={close}>
      {sales.length === 0 ? (
        <EmptyState
          title="Belum ada transaksi"
          detail="Transaksi yang selesai akan muncul di sini."
        />
      ) : (
        sales.map((item) => (
          <Row
            key={item.id}
            title={item.receiptNumber}
            detail={`${new Date(item.occurredAt).toLocaleString("id-ID")} • ${item.paymentMethod.toUpperCase()}`}
            right={
              <View style={s.saleRight}>
                <Text style={s.saleAmount}>
                  {formatRupiah(item.totalMinor)}
                </Text>
                <Badge text={salePaymentStatusLabel(item)} tone={item.paymentStatus === "paid" ? "green" : item.status === "void" ? "red" : "amber"} />
              </View>
            }
            onPress={() => setSelected(item)}
          />
        ))
      )}
      <RefundSheet
        sale={selected}
        workspace={workspace}
        close={() => setSelected(null)}
        saved={async () => {
          setSelected(null);
          await load();
          await onChanged();
        }}
      />
    </Sheet>
  );
}
function RefundSheet({
  sale,
  workspace,
  close,
  saved,
}: {
  sale: SaleHistoryItem | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [restock, setRestock] = React.useState(true);
  const canApprove = ["owner", "business_manager", "branch_manager", "supervisor"].includes(workspace.role);
  React.useEffect(() => {
    const timer = setTimeout(
      () => setAmount(sale ? String(sale.totalMinor) : ""),
      0,
    );
    return () => clearTimeout(timer);
  }, [sale]);
  const submit = async () => {
    if (!sale) return;
    const value = Math.round(Number(amount));
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > sale.totalMinor ||
      reason.trim().length < 4
    ) {
      localizedAlert("Periksa formulir", "Nominal dan alasan retur wajib valid.");
      return;
    }
    const approved = canApprove,
      id = Crypto.randomUUID();
    if (approved && sale.paymentMethod === "qris") {
      if (!supabase) {
        localizedAlert("Retur QRIS", "Backend diperlukan untuk memproses refund QRIS.");
        return;
      }
      const { error } = await supabase.functions.invoke("refund-midtrans", {
        body: { saleId: sale.id, refundId: id, amount: value, reason: reason.trim(), stockDisposition: restock ? "restock" : "damaged" },
      });
      if (error) localizedAlert("Retur QRIS gagal", error.message);
      else {
        localizedAlert("Retur QRIS diproses", "Status refund dicatat oleh server Midtrans.");
        await saved();
      }
      return;
    }
    await requestRefund(db, workspace, {
      id,
      saleId: sale.id,
      amountMinor: value,
      reason: reason.trim(),
      stockDisposition: restock ? "restock" : "damaged",
      approved,
      mutation: await createMutation(workspace, "refund", id, "create", {
        saleId: sale.id,
        amountMinor: value,
        reason: reason.trim(),
        stockDisposition: restock ? "restock" : "damaged",
        approved,
      }),
    });
    localizedAlert(
      "Retur dicatat",
      approved
        ? "Retur diposting dan jurnal koreksi akan disinkronkan."
        : "Permintaan menunggu persetujuan supervisor/pemilik.",
    );
    await saved();
  };
  return (
    <Sheet visible={Boolean(sale)} title="Retur transaksi" onClose={close}>
      <Row
        title={sale?.receiptNumber ?? ""}
        detail={formatRupiah(sale?.totalMinor ?? 0)}
      />
      <Field
        label="Nominal retur"
        value={amount}
        onChangeText={setAmount}
        keyboardType="numeric"
      />
      <Field
        label="Alasan wajib"
        value={reason}
        onChangeText={setReason}
        multiline
      />
      <View style={s.disposition}>
        <Button
          variant={restock ? "secondary" : "outline"}
          compact
          title="Kembali ke stok"
          onPress={() => setRestock(true)}
        />
        <Button
          variant={!restock ? "secondary" : "outline"}
          compact
          title="Rusak / tidak layak"
          onPress={() => setRestock(false)}
        />
      </View>
      <Text style={s.intro}>
        {canApprove
          ? "Peran ini dapat menyetujui retur. Koreksi dibuat sebagai event baru."
          : "Permintaan retur akan masuk ke pusat persetujuan atasan."}
      </Text>
      <Button title="Proses retur" onPress={() => void submit()} />
    </Sheet>
  );
}

const s = StyleSheet.create({
  formIntro:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.line,borderRadius:12,padding:12,flexDirection:"row",gap:10},
  formMarker:{width:4,borderRadius:4},
  formIntroCopy:{flex:1},
  formEyebrow:{color:colors.blue,fontSize:9,fontWeight:"900",letterSpacing:1},
  formDescription:{color:colors.muted,fontSize:11,lineHeight:16,marginTop:3},
  formSection:{fontSize:9,fontWeight:"900",letterSpacing:1.2,color:colors.blue,marginTop:5},
  searchBox:{minHeight:46,borderWidth:1,borderColor:colors.line,borderRadius:12,backgroundColor:colors.surface,flexDirection:"row",alignItems:"center",paddingHorizontal:12,gap:8},
  searchIcon:{color:colors.blue,fontSize:20,fontWeight:"900"},
  searchInput:{flex:1,color:colors.ink,fontSize:13,paddingVertical:12},
  quickGrid:{flexDirection:"row",flexWrap:"wrap",gap:10},
  quickAction:{width:"48.4%",minHeight:86,borderRadius:12,padding:12,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.line},
  quickIcon:{width:28,height:28,borderRadius:9,alignItems:"center",justifyContent:"center",backgroundColor:colors.blueSoft},
  quickIconText:{color:colors.blue,fontWeight:"900",fontSize:13},
  quickTitle:{color:colors.ink,fontWeight:"900",fontSize:12,marginTop:8},
  quickDetail:{color:colors.muted,fontSize:9,marginTop:2,lineHeight:13},
  groupTabs:{gap:7,paddingRight:12},
  groupTab:{paddingHorizontal:12,paddingVertical:8,borderRadius:999,borderWidth:1,borderColor:colors.line,backgroundColor:colors.surface},
  groupTabActive:{borderColor:colors.blue,backgroundColor:colors.blue},
  groupTabText:{fontSize:10,fontWeight:"800",color:colors.muted},
  groupTabTextActive:{color:colors.white},
  salesHero: {
    backgroundColor: colors.navy,
    borderRadius: radius.lg,
    padding: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  salesTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "900",
    marginTop: 12,
  },
  salesDetail: { color: "#B7CBDB", fontSize: 11, marginTop: 4 },
  bigArrow: { fontSize: 34, color: colors.orange },
  group: { gap: 8 },
  groupTitle: {
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 1.2,
    color: colors.muted,
    marginTop: 5,
  },
  moduleList:{gap:6},
  moduleRow:{minHeight:64,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.line,borderRadius:12,padding:11,flexDirection:"row",alignItems:"center",gap:10},
  moduleIcon:{width:36,height:36,borderRadius:11,backgroundColor:colors.blueSoft,alignItems:"center",justifyContent:"center"},
  moduleIconText:{color:colors.blue,fontSize:15,fontWeight:"900"},
  moduleCopy:{flex:1},
  moduleTitle:{fontSize:14,fontWeight:"900",color:colors.ink},
  moduleDetail:{fontSize:10,color:colors.muted,lineHeight:15,marginTop:3},
  moduleArrow:{color:colors.blue,fontSize:24,fontWeight:"700"},
  tile: {
    width: "48.4%",
    minHeight: 142,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.lg,
    padding: 14,
  },
  pressed: { opacity: 0.6 },
  tileIcon: {
    width: 37,
    height: 37,
    borderRadius: 13,
    backgroundColor: colors.orangeSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  tileIconText: { color: colors.orange, fontSize: 17, fontWeight: "900" },
  tileTitle: {
    fontSize: 13,
    fontWeight: "900",
    color: colors.ink,
    marginTop: 11,
  },
  tileDetail: {
    fontSize: 10,
    color: colors.muted,
    lineHeight: 15,
    marginTop: 4,
  },
  intro: { fontSize: 11, color: colors.muted, lineHeight: 17 },
  saleRight: { alignItems: "flex-end", gap: 5 },
  saleAmount: { fontSize: 12, fontWeight: "900", color: colors.ink },
  disposition: { flexDirection: "row", gap: 8 },
  statusPanel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.md,
    backgroundColor: colors.cream,
    padding: 12,
  },
  statusLabel: { fontSize: 10, fontWeight: "900", color: colors.muted },
  booleanField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 8,
    gap: 12,
  },
  booleanCopy: { flex: 1 },
  booleanLabel: { color: colors.ink, fontSize: 12, fontWeight: "800" },
  booleanHelp: { color: colors.muted, fontSize: 10, marginTop: 3 },
  choiceField: { gap: 8 },
  choiceWrap: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  choice: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  choiceActive: { borderColor: colors.navy, backgroundColor: colors.navy },
  choiceText: { color: colors.muted, fontWeight: "700", fontSize: 11 },
  choiceTextActive: { color: colors.white },
  lineEditor:{gap:9,borderWidth:1,borderColor:colors.line,borderRadius:12,backgroundColor:colors.surface,padding:12},
  lineHeader:{flexDirection:"row",alignItems:"center",justifyContent:"space-between"},
  lineTitle:{fontSize:10,fontWeight:"900",letterSpacing:1,color:colors.ink},
  lineHelp:{fontSize:11,lineHeight:16,color:colors.muted},
  productPicker:{flexDirection:"row",flexWrap:"wrap",gap:6},
  productChoice:{maxWidth:"48%",flexDirection:"row",alignItems:"center",gap:6,borderWidth:1,borderColor:colors.line,borderRadius:999,paddingHorizontal:7,paddingVertical:5},
  productChoicePlus:{fontSize:12,color:colors.blue,fontWeight:"900"},
  productChoiceText:{maxWidth:120,fontSize:10,color:colors.ink,fontWeight:"700"},
  purchaseLine:{borderTopWidth:1,borderTopColor:colors.line,paddingTop:9,gap:7},
  purchaseLineTop:{flexDirection:"row",alignItems:"center",gap:10},
  purchaseName:{fontSize:12,fontWeight:"900",color:colors.ink},
  purchaseSku:{fontSize:9,color:colors.muted,marginTop:2},
  removeLine:{fontSize:10,fontWeight:"800",color:colors.red},
  purchaseInputs:{gap:10},
  purchaseInput:{flex:1},
  purchaseSubtotal:{textAlign:"right",fontSize:12,fontWeight:"900",color:colors.ink},
  lineTotal:{borderTopWidth:1,borderTopColor:colors.line,paddingTop:10,flexDirection:"row",justifyContent:"space-between",alignItems:"center"},
  lineTotalLabel:{fontSize:11,color:colors.muted,fontWeight:"700"},
  lineTotalValue:{fontSize:15,color:colors.blue,fontWeight:"900"},
});
