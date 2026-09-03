import {
  adjustStock,
  archiveProduct,
  listLocalProducts,
  saveLocalProduct,
  uploadProductImage,
  type LocalProduct,
} from "@/lib/remote-store";
import { formatRupiah } from "@niagacore/domain";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import { useRemoteStore } from "@/lib/remote-store";
import React from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from "react-native";

import { createMutation } from "@/lib/mutations";
import { useBusinessRealtime } from "@/hooks/use-business-realtime";
import { MAX_PRODUCT_IMAGE_BYTES, productImageErrorMessage } from "@/lib/product-image";
import type { ActiveWorkspace } from "@/providers/auth-provider";
import { useAppTheme } from "@/providers/theme-provider";
import { BarcodeScannerSheet } from "@/ui/barcode-scanner-sheet";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Header,
  Row,
  Screen,
  Segmented,
  Sheet,
  ProductImage,
} from "@/ui/components";
import { colors, radius } from "@/ui/theme";
import { LocalizedText as Text, localizedAlert, translateUi } from "@/ui/localized-text";

export function ProductsScreen({
  workspace,
  onChanged,
}: {
  workspace: ActiveWorkspace;
  onChanged: () => Promise<void>;
}) {
  const theme=useAppTheme();
  const db = useRemoteStore();
  const canEditCatalog = ["owner", "business_manager", "branch_manager", "supervisor"].includes(workspace.role);
  const canAdjustStock = canEditCatalog || workspace.role === "warehouse";
  const [products, setProducts] = React.useState<LocalProduct[]>([]);
  const [search, setSearch] = React.useState("");
  const [editing, setEditing] = React.useState<LocalProduct | null | undefined>(
    undefined,
  );
  const [stockProduct, setStockProduct] = React.useState<LocalProduct | null>(
    null,
  );
  const load = React.useCallback(
    async () =>
      setProducts(
        await listLocalProducts(db, workspace.tenantId, workspace.branchId),
      ),
    [db, workspace],
  );
  React.useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useBusinessRealtime(workspace,load);
  const changed = async () => {
    await load();
    await onChanged();
  };
  const visible = products.filter((p) =>
    `${p.name} ${p.sku} ${p.barcode ?? ""} ${p.category}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const archive = (p: LocalProduct) =>
    localizedAlert(
      "Arsipkan produk",
      `${p.name} tidak lagi tampil di kasir. Riwayat transaksi tetap aman.`,
      [
        { text: "Batal", style: "cancel" },
        {
          text: "Arsipkan",
          style: "destructive",
          onPress: () => void (async () =>
            archiveProduct(
              db,
              p.id,
              await createMutation(
                workspace,
                "product",
                p.id,
                "archive",
                { id: p.id },
                p.version,
              ),
            ).then(changed))(),
        },
      ],
    );
  return (
    <Screen>
      <Header
        title="Produk & stok"
        subtitle={`${products.length} produk aktif • kelola harga, SKU, barcode, dan persediaan`}
        right={
          canEditCatalog ? <Button compact title="＋ Produk" onPress={() => setEditing(null)} /> : <Badge text="Hanya baca" tone="neutral" />
        }
      />
      <View style={[s.search,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
        <Text style={s.searchIcon}>⌕</Text>
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={translateUi("Cari nama, SKU, barcode, kategori")}
          placeholderTextColor={theme.colors.muted}
          style={[s.searchInput,{color:theme.colors.ink}]}
        />
      </View>
      {visible.length === 0 ? (
        <EmptyState
          title="Produk tidak ditemukan"
          detail="Tambahkan produk pertama atau ubah kata pencarian."
          action={canEditCatalog ? (
            <Button title="Tambah produk" onPress={() => setEditing(null)} />
          ) : undefined}
        />
      ) : (
        visible.map((p) => (
          <Pressable key={p.id} onPress={() => canEditCatalog ? setEditing(p) : canAdjustStock ? setStockProduct(p) : undefined}>
            <Row
              title={p.name}
              detail={`${p.sku} • ${p.category} • ${formatRupiah(p.priceMinor)}`}
              left={<ProductImage uri={p.imageUri} name={p.name}/>} 
              accent={p.stock <= p.minimumStock ? colors.red : colors.green}
              right={
                <View style={s.right}>
                  <Text style={s.stock}>
                    {p.stock} {p.unit}
                  </Text>
                  <Badge
                    text={
                      p.stock <= p.minimumStock ? "Stok rendah" : "Tersedia"
                    }
                    tone={p.stock <= p.minimumStock ? "red" : "green"}
                  />
                </View>
              }
            />
          </Pressable>
        ))
      )}
      {canEditCatalog && <ProductSheet
        visible={editing !== undefined}
        product={editing ?? null}
        workspace={workspace}
        close={() => setEditing(undefined)}
        saved={async () => {
          setEditing(undefined);
          await changed();
        }}
        adjust={() => {
          if (editing) setStockProduct(editing);
        }}
        archive={() => editing && archive(editing)}
      />}
      <StockSheet
        visible={Boolean(stockProduct)}
        product={stockProduct}
        workspace={workspace}
        close={() => setStockProduct(null)}
        saved={async () => {
          setStockProduct(null);
          setEditing(undefined);
          await changed();
        }}
      />
    </Screen>
  );
}

function ProductSheet({
  visible,
  product,
  workspace,
  close,
  saved,
  adjust,
  archive,
}: {
  visible: boolean;
  product: LocalProduct | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
  adjust: () => void;
  archive: () => void;
}) {
  const theme=useAppTheme();
  const db = useRemoteStore();
  const [name, setName] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [barcode, setBarcode] = React.useState("");
  const [category, setCategory] = React.useState("Umum");
  const [price, setPrice] = React.useState("");
  const [cost, setCost] = React.useState("");
  const [stock, setStock] = React.useState("0");
  const [minimum, setMinimum] = React.useState("0");
  const [unit, setUnit] = React.useState("pcs");
  const [tax, setTax] = React.useState("0");
  const [productType, setProductType] = React.useState<LocalProduct["productType"]>("goods");
  const [description, setDescription] = React.useState("");
  const [imagePath, setImagePath] = React.useState<string|null>(null);
  const [imagePreview, setImagePreview] = React.useState<string|null>(null);
  const [pendingImage,setPendingImage]=React.useState<{base64:string;fileSize?:number|null;mimeType?:string|null}|null>(null);
  const [variants, setVariants] = React.useState("");
  const [unitConversions, setUnitConversions] = React.useState("");
  const [trackStock, setTrackStock] = React.useState(true);
  const [allowNegative, setAllowNegative] = React.useState(false);
  const [scannerOpen, setScannerOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [advanced, setAdvanced] = React.useState(false);
  React.useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      setName(product?.name ?? "");
      setSku(product?.sku ?? "");
      setBarcode(product?.barcode ?? "");
      setCategory(product?.category ?? "Umum");
      setPrice(String(product?.priceMinor ?? ""));
      setCost(String(product?.costMinor ?? ""));
      setStock(String(product?.stock ?? 0));
      setMinimum(String(product?.minimumStock ?? 0));
      setUnit(product?.unit ?? "pcs");
      setTax(String(product?.taxRate ?? 0));
      setProductType(product?.productType ?? "goods");
      setDescription(product?.description ?? "");
      setImagePath(product?.imagePath ?? null);
      setImagePreview(product?.imageUri ?? null);
      setPendingImage(null);
      setVariants(String(product?.metadata.variants ?? ""));
      setUnitConversions(String(product?.metadata.unitConversions ?? ""));
      setTrackStock(product?.trackStock ?? true);
      setAllowNegative(product?.allowNegative ?? false);
      setAdvanced(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [product, visible]);
  const chooseImage=async()=>{
    const permission=await ImagePicker.requestMediaLibraryPermissionsAsync();
    if(!permission.granted){localizedAlert("Foto produk","Izinkan akses galeri untuk memilih foto produk.");return;}
    const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:["images"],allowsEditing:true,aspect:[1,1],quality:.8,base64:true});
    if(result.canceled)return;
    const asset=result.assets[0];
    if(!asset)return;
    if((asset.fileSize??0)>MAX_PRODUCT_IMAGE_BYTES){localizedAlert("Foto produk","Ukuran foto melebihi batas 5 MB. Pilih foto yang lebih kecil.");return;}
    if(!asset.base64){localizedAlert("Foto produk","Foto tidak dapat dibaca. Pilih foto lain dari galeri lalu coba kembali.");return;}
    setPendingImage({base64:asset.base64,fileSize:asset.fileSize,mimeType:asset.mimeType});
    setImagePreview(asset.uri);
  };
  const submit = async () => {
    const priceMinor = Number(price),
      costMinor = Number(cost || 0),
      openingStock = Number(stock || 0),
      minimumStock = Number(minimum || 0),
      taxRate = Number(tax || 0);
    if (
      name.trim().length < 2 ||
      !sku.trim() ||
      [priceMinor, costMinor, openingStock, minimumStock, taxRate].some(
        (v) => !Number.isFinite(v) || v < 0,
      )
    ) {
      localizedAlert(
        "Periksa formulir",
        "Nama, SKU, harga, stok, dan pajak harus valid.",
      );
      return;
    }
    setBusy(true);
    const id = product?.id ?? Crypto.randomUUID();
    let savedImagePath=imagePath;
    try {
      if(pendingImage)savedImagePath=(await uploadProductImage(db,workspace,id,pendingImage)).path;
    } catch(error) {
      setBusy(false);
      localizedAlert("Foto produk",productImageErrorMessage(error));
      return;
    }
    const payload = {
      sku: sku.trim(),
      barcode: barcode.trim() || null,
      name: name.trim(),
      category: category.trim() || "Umum",
      priceMinor: Math.round(priceMinor),
      costMinor: Math.round(costMinor),
      unit: unit.trim() || "pcs",
      taxRate,
      minimumStock,
      productType,
      description: description.trim() || null,
      imageUri: savedImagePath,
      trackStock,
      allowNegative,
      metadata: {
        variants: variants.trim(),
        unitConversions: unitConversions.trim(),
      },
    };
    const mutationPayload = {
      ...payload,
      openingStock: product ? product.stock : openingStock,
    };
    try {
      await saveLocalProduct(db, {
        id,
        ...payload,
        imagePath:savedImagePath,
        imageUri:imagePreview,
        stock: product ? product.stock : openingStock,
        minimumStock,
        version: product?.version ?? 0,
        context: workspace,
        mutation: await createMutation(
          workspace,
          "product",
          id,
          product ? "update" : "create",
          mutationPayload,
          product?.version ?? null,
        ),
      });
      await saved();
    } catch (error) {
      localizedAlert(
        "Produk",
        error instanceof Error ? error.message : "Gagal menyimpan produk",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      visible={visible}
      title={product ? "Edit produk" : "Produk baru"}
      onClose={close}
    >
      <Text style={s.sectionLabel}>INFORMASI UTAMA</Text>
      <View style={[s.photoCard,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
        <ProductImage uri={imagePreview} name={name||"Produk"} size={86}/>
        <View style={s.photoCopy}>
          <Text style={s.photoTitle}>Foto produk</Text>
          <Text style={s.helper}>Tampil di katalog produk dan layar kasir. Maksimal 5 MB.</Text>
          <View style={s.photoActions}><Button compact title={imagePreview?"Ganti foto":"Pilih foto"} onPress={()=>void chooseImage()}/>{imagePreview&&<Button compact variant="ghost" title="Hapus" onPress={()=>{setPendingImage(null);setImagePath(null);setImagePreview(null)}}/>}</View>
        </View>
      </View>
      <Field label="Nama produk / jasa" value={name} onChangeText={setName} />
      <Text style={s.fieldLabel}>JENIS ITEM</Text>
      <Segmented
        value={productType}
        onChange={setProductType}
        items={[
          { value: "goods", label: "Barang" },
          { value: "service", label: "Jasa" },
          { value: "recipe", label: "Resep" },
          { value: "bundle", label: "Bundel" },
        ]}
      />
      <View style={s.two}>
        <View style={s.flex}>
          <Field label="SKU" value={sku} onChangeText={setSku} />
        </View>
        <View style={s.flex}>
          <Field label="Barcode" value={barcode} onChangeText={setBarcode} />
          <Button
            compact
            variant="outline"
            title="Pindai barcode"
            onPress={() => setScannerOpen(true)}
          />
        </View>
      </View>
      <Field label="Kategori" value={category} onChangeText={setCategory} />
      <Text style={s.sectionLabel}>HARGA & PERSEDIAAN</Text>
      <View style={s.two}>
        <View style={s.flex}>
          <Field
            label="Harga jual"
            value={price}
            onChangeText={setPrice}
            keyboardType="numeric"
          />
        </View>
        <View style={s.flex}>
          <Field
            label="HPP awal"
            value={cost}
            onChangeText={setCost}
            keyboardType="numeric"
          />
        </View>
      </View>
      <View style={s.toggleRow}>
        <View style={s.flex}>
          <Text style={s.toggleTitle}>Lacak persediaan</Text>
          <Text style={s.helper}>Nonaktif untuk jasa atau item non-stok.</Text>
        </View>
        <Switch value={trackStock} onValueChange={setTrackStock} />
      </View>
      <View style={s.two}>
        <View style={s.flex}>
          <Field
            label={product ? "Stok saat ini" : "Stok awal"}
            value={stock}
            onChangeText={setStock}
            keyboardType="numeric"
          />
        </View>
        <View style={s.flex}>
          <Field
            label="Stok minimum"
            value={minimum}
            onChangeText={setMinimum}
            keyboardType="numeric"
          />
        </View>
      </View>
      <Field label="Satuan" value={unit} onChangeText={setUnit} />
      <Button variant="outline" title={advanced?"Sembunyikan pengaturan tambahan":"Tampilkan pengaturan tambahan"} onPress={()=>setAdvanced((value)=>!value)}/>
      {advanced && <View style={[s.advanced,{backgroundColor:theme.colors.surface,borderColor:theme.colors.line}]}>
        <Text style={s.sectionLabel}>DETAIL TAMBAHAN</Text>
        <Field label="Deskripsi" value={description} onChangeText={setDescription} multiline />
        <Field label="Varian (contoh: Ukuran=S,M,L; Warna=Hitam,Putih)" value={variants} onChangeText={setVariants}/>
        <Field label="Konversi satuan (contoh: 1 dus = 24 pcs)" value={unitConversions} onChangeText={setUnitConversions}/>
        <View style={s.toggleRow}><View style={s.flex}><Text style={s.toggleTitle}>Izinkan stok minus item</Text><Text style={s.helper}>Gunakan hanya jika kebijakan usaha mengizinkan.</Text></View><Switch value={allowNegative} onValueChange={setAllowNegative}/></View>
        <Field label="Pajak %" value={tax} onChangeText={setTax} keyboardType="numeric"/>
      </View>}
      {product && (
        <Text style={s.helper}>
          Perubahan stok dicatat melalui ledger penyesuaian agar dapat diaudit.
        </Text>
      )}
      <Button
        title={busy ? "Menyimpan..." : "Simpan produk"}
        disabled={busy}
        onPress={() => void submit()}
      />
      {product && (
        <View style={s.two}>
          <View style={s.flex}>
            <Button variant="outline" title="Sesuaikan stok" onPress={adjust} />
          </View>
          <View style={s.flex}>
            <Button variant="danger" title="Arsipkan" onPress={archive} />
          </View>
        </View>
      )}
      <BarcodeScannerSheet
        visible={scannerOpen}
        title="Barcode produk"
        onClose={() => setScannerOpen(false)}
        onScanned={(value) => {
          setBarcode(value);
          setScannerOpen(false);
        }}
      />
    </Sheet>
  );
}

function StockSheet({
  visible,
  product,
  workspace,
  close,
  saved,
}: {
  visible: boolean;
  product: LocalProduct | null;
  workspace: ActiveWorkspace;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const db = useRemoteStore();
  const [quantity, setQuantity] = React.useState("");
  const [reason, setReason] = React.useState("Stok opname");
  const submit = async () => {
    if (!product) return;
    const value = Number(quantity);
    if (!Number.isFinite(value) || value === 0 || reason.trim().length < 3) {
      localizedAlert("Periksa formulir");
      return;
    }
    const id = Crypto.randomUUID();
    await adjustStock(db, workspace, {
      id,
      productId: product.id,
      quantity: value,
      reason: reason.trim(),
      mutation: await createMutation(workspace, "stock_adjustment", id, "create", {
        productId: product.id,
        quantity: value,
        reason: reason.trim(),
      }),
    });
    await saved();
  };
  return (
    <Sheet visible={visible} title="Penyesuaian stok" onClose={close}>
      <Row
        title={product?.name ?? ""}
        detail={`Stok tercatat: ${product?.stock ?? 0} ${product?.unit ?? ""}`}
      />
      <Field
        label="Perubahan kuantitas"
        value={quantity}
        onChangeText={setQuantity}
        keyboardType="numeric"
        placeholder={translateUi("Contoh: 5 atau -2")}
      />
      <Field label="Alasan wajib" value={reason} onChangeText={setReason} />
      <Text style={s.helper}>
        Nilai positif menambah stok, nilai negatif mengurangi stok. Catatan
        tidak dapat dihapus dari jejak audit.
      </Text>
      <Button title="Simpan penyesuaian" onPress={() => void submit()} />
    </Sheet>
  );
}

const s = StyleSheet.create({
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
  right: { alignItems: "flex-end", gap: 5 },
  stock: { fontSize: 13, fontWeight: "900", color: colors.ink },
  two: { gap: 12 },
  flex: { flex: 1 },
  helper: { fontSize: 11, color: colors.muted, lineHeight: 17 },
  fieldLabel: { fontSize: 10, color: colors.muted, fontWeight: "900" },
  sectionLabel:{fontSize:9,color:colors.blue,fontWeight:"900",letterSpacing:1.1,marginTop:2},
  photoCard:{flexDirection:"row",alignItems:"center",gap:12,padding:12,borderWidth:1,borderColor:colors.line,borderRadius:16,backgroundColor:"#F8FAFE"},
  photoCopy:{flex:1,gap:5},
  photoTitle:{fontSize:14,fontWeight:"900",color:colors.ink},
  photoActions:{flexDirection:"row",alignItems:"center",gap:4,marginTop:3},
  advanced:{gap:10,padding:12,borderWidth:1,borderColor:colors.line,borderRadius:12,backgroundColor:"#F8FAFE"},
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 7,
  },
  toggleTitle: { color: colors.ink, fontSize: 12, fontWeight: "800" },
});
