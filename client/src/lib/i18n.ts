import { useSyncExternalStore } from "react";

// Lightweight i18n, same store pattern as lib/features.ts (no provider needed):
// a localStorage-backed language with a custom-event subscription, plus per-key
// dictionaries. t(key) falls back to English, then to the raw key. English
// values are kept byte-identical to the original UI strings so existing tests
// (which run in the default `en`) keep passing.

export type Lang = "en" | "uk" | "es" | "de";

export const LANGS: { code: Lang; label: string }[] = [
  { code: "en", label: "English" },
  { code: "uk", label: "Українська" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
];

const KEY = "balance-lang";
const EVENT = "balance-lang-change";

function isLang(v: unknown): v is Lang {
  return v === "en" || v === "uk" || v === "es" || v === "de";
}

export function getLang(): Lang {
  try {
    const s = localStorage.getItem(KEY);
    if (isLang(s)) return s;
  } catch { /* storage unavailable */ }
  return "en";
}

export function setLang(lang: Lang): void {
  try { localStorage.setItem(KEY, lang); } catch { /* storage unavailable */ }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

// Reflect the stored language on <html lang> as soon as the module loads.
if (typeof document !== "undefined") document.documentElement.lang = getLang();

type Dict = Record<string, string>;

const en: Dict = {
  "nav.transactions": "Transactions",
  "nav.reports": "Reports",
  "nav.accounts": "Accounts",
  "nav.settings": "Settings",

  "common.add": "Add",
  "common.edit": "Edit",
  "common.done": "Done",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.signOut": "Sign out",

  "accounts.addAccount": "Add Account",
  "accounts.netWorth": "Total net worth",
  "accounts.empty": "No accounts yet. Add your first account to start tracking your balance.",

  "tx.searchPlaceholder": "Search by amount, category or comment...",
  "tx.filter": "Filter",
  "tx.addTransaction": "Add transaction",
  "tx.emptyNoFilters": "No transactions yet. Add your first one to get started.",
  "tx.emptyFiltered": "No transactions match the current filters.",

  "settings.householdName": "Household name",
  "settings.members": "Members",
  "settings.inviteMember": "Invite a member",
  "settings.invite": "Invite",
  "settings.manage": "Manage",
  "settings.categories": "Categories",
  "settings.baseCurrency": "Default account currency",
  "settings.baseCurrencyHint": "Default currency for new accounts. Existing accounts keep their currency.",
  "settings.appearance": "Appearance",
  "settings.appearanceHint": "Choose a theme, or follow your device setting.",
  "settings.textSize": "Text size",
  "settings.textSizeHint": "Choose a larger, touch-friendly size or a more compact one.",
  "settings.language": "Language",
  "settings.languageHint": "Translates navigation and key screens. Some advanced tools remain in English.",
  "settings.experimental": "Experimental features",

  "signin.subtitle": "Sign in to your household",
  "signin.google": "Sign in with Google",
  "signin.inviteOnly": "Invite-only. Access is granted by a household admin.",

  "common.clear": "Clear",

  "txType.debit": "Expense",
  "txType.credit": "Income",
  "txType.transfer": "Transfer",

  "accountGroup.Credit": "Credit",
  "accountGroup.Banking": "Banking",
  "accountGroup.Invested": "Invested",
  "accountGroup.Locked": "Locked",

  "accountType.Cash": "Cash",
  "accountType.Checking": "Checking",
  "accountType.Savings": "Savings",
  "accountType.CC": "Credit card",
  "accountType.Investment": "Investment",
  "accountType.Roth401k": "Roth 401(k)",
  "accountType.401k": "401(k)",
  "accountType.HSA": "HSA",
  "accountType.Asset-NonLiquid": "Illiquid Asset",
  "accountType.RSU": "RSU",

  "theme.light": "Light",
  "theme.dark": "Dark",
  "theme.system": "System",

  "fontSize.default": "Default",
  "fontSize.compact": "Compact",

  "tx.col.date": "Date",
  "tx.col.amount": "Amount",
  "tx.col.category": "Category",
  "tx.col.account": "Account",
  "tx.col.labels": "Labels",
  "tx.col.type": "Type",
  "tx.addMultiple": "Add Multiple",
  "tx.bulkImport": "Bulk Import",
  "tx.uncategorized": "Uncategorized",
  "tx.notInReports": "Not in reports",
  "tx.loading": "Loading transactions…",
  "tx.loadingMore": "Loading more…",
  "tx.scrollForMore": "Scroll for more",

  "reports.spend-by-category": "Spend by Category",
  "reports.income-spend-savings": "Income vs Spend",
  "reports.spend-over-time": "Spend Over Time",
  "reports.period-comparison": "Period Comparison",
  "reports.subscriptions": "Subscriptions",
  "reports.chart": "Chart",
  "reports.table": "Table",
  "reports.total": "Total",
  "reports.average": "Average",
  "reports.noSpend": "No spend in this period.",

  "period.this-month": "This month",
  "period.last-month": "Last",
  "period.3m": "3m",
  "period.6m": "6m",
  "period.1y": "1y",
  "period.3y": "3y",
  "period.this-year": "This year",
  "period.last-year": "Last year",
  "period.all": "All time",
  "period.custom": "Custom",

  "accounts.showInactive": "Show inactive",
  "accounts.hideInactive": "Hide inactive",
  "accounts.editAccount": "Edit Account",

  "categories.title": "Categories",
};

const uk: Dict = {
  "nav.transactions": "Транзакції",
  "nav.reports": "Звіти",
  "nav.accounts": "Рахунки",
  "nav.settings": "Налаштування",

  "common.add": "Додати",
  "common.edit": "Редагувати",
  "common.done": "Готово",
  "common.save": "Зберегти",
  "common.cancel": "Скасувати",
  "common.signOut": "Вийти",

  "accounts.addAccount": "Додати рахунок",
  "accounts.netWorth": "Загальний капітал",
  "accounts.empty": "Ще немає рахунків. Додайте перший рахунок, щоб почати відстежувати баланс.",

  "tx.searchPlaceholder": "Пошук за сумою, категорією або коментарем...",
  "tx.filter": "Фільтр",
  "tx.addTransaction": "Додати транзакцію",
  "tx.emptyNoFilters": "Ще немає транзакцій. Додайте першу, щоб почати.",
  "tx.emptyFiltered": "Немає транзакцій за поточними фільтрами.",

  "settings.householdName": "Назва домогосподарства",
  "settings.members": "Учасники",
  "settings.inviteMember": "Запросити учасника",
  "settings.invite": "Запросити",
  "settings.manage": "Керування",
  "settings.categories": "Категорії",
  "settings.baseCurrency": "Валюта рахунку за замовчуванням",
  "settings.baseCurrencyHint": "Валюта за замовчуванням для нових рахунків. Наявні рахунки зберігають свою валюту.",
  "settings.appearance": "Оформлення",
  "settings.appearanceHint": "Оберіть тему або дотримуйтесь налаштувань пристрою.",
  "settings.textSize": "Розмір тексту",
  "settings.textSizeHint": "Оберіть більший, зручний для дотику розмір або компактніший.",
  "settings.language": "Мова",
  "settings.languageHint": "Перекладає навігацію та основні екрани. Деякі розширені інструменти залишаються англійською.",
  "settings.experimental": "Експериментальні функції",

  "signin.subtitle": "Увійдіть до свого домогосподарства",
  "signin.google": "Увійти через Google",
  "signin.inviteOnly": "Лише за запрошенням. Доступ надає адміністратор домогосподарства.",

  "common.clear": "Очистити",

  "txType.debit": "Витрата",
  "txType.credit": "Дохід",
  "txType.transfer": "Переказ",

  "accountGroup.Credit": "Кредитні",
  "accountGroup.Banking": "Банківські",
  "accountGroup.Invested": "Інвестиції",
  "accountGroup.Locked": "Заблоковані",

  "accountType.Cash": "Готівка",
  "accountType.Checking": "Поточний",
  "accountType.Savings": "Ощадний",
  "accountType.CC": "Кредитна картка",
  "accountType.Investment": "Інвестиції",
  "accountType.Roth401k": "Roth 401(k)",
  "accountType.401k": "401(k)",
  "accountType.HSA": "HSA",
  "accountType.Asset-NonLiquid": "Неліквідний актив",
  "accountType.RSU": "RSU",

  "theme.light": "Світла",
  "theme.dark": "Темна",
  "theme.system": "Системна",

  "fontSize.default": "Звичайний",
  "fontSize.compact": "Компактний",

  "tx.col.date": "Дата",
  "tx.col.amount": "Сума",
  "tx.col.category": "Категорія",
  "tx.col.account": "Рахунок",
  "tx.col.labels": "Мітки",
  "tx.col.type": "Тип",
  "tx.addMultiple": "Додати кілька",
  "tx.bulkImport": "Масовий імпорт",
  "tx.uncategorized": "Без категорії",
  "tx.notInReports": "Не у звітах",
  "tx.loading": "Завантаження транзакцій…",
  "tx.loadingMore": "Завантаження…",
  "tx.scrollForMore": "Прокрутіть, щоб побачити більше",

  "reports.spend-by-category": "Витрати за категоріями",
  "reports.income-spend-savings": "Доходи та витрати",
  "reports.spend-over-time": "Витрати в часі",
  "reports.period-comparison": "Порівняння періодів",
  "reports.subscriptions": "Підписки",
  "reports.chart": "Діаграма",
  "reports.table": "Таблиця",
  "reports.total": "Разом",
  "reports.average": "Середнє",
  "reports.noSpend": "Немає витрат за цей період.",

  "period.this-month": "Цей місяць",
  "period.last-month": "Минулий",
  "period.3m": "3м",
  "period.6m": "6м",
  "period.1y": "1р",
  "period.3y": "3р",
  "period.this-year": "Цей рік",
  "period.last-year": "Минулий рік",
  "period.all": "Увесь час",
  "period.custom": "Інший",

  "accounts.showInactive": "Показати неактивні",
  "accounts.hideInactive": "Сховати неактивні",
  "accounts.editAccount": "Редагувати рахунок",

  "categories.title": "Категорії",
};

const es: Dict = {
  "nav.transactions": "Transacciones",
  "nav.reports": "Informes",
  "nav.accounts": "Cuentas",
  "nav.settings": "Ajustes",

  "common.add": "Añadir",
  "common.edit": "Editar",
  "common.done": "Hecho",
  "common.save": "Guardar",
  "common.cancel": "Cancelar",
  "common.signOut": "Cerrar sesión",

  "accounts.addAccount": "Añadir cuenta",
  "accounts.netWorth": "Patrimonio neto total",
  "accounts.empty": "Aún no hay cuentas. Añade tu primera cuenta para empezar a controlar tu saldo.",

  "tx.searchPlaceholder": "Buscar por importe, categoría o comentario...",
  "tx.filter": "Filtrar",
  "tx.addTransaction": "Añadir transacción",
  "tx.emptyNoFilters": "Aún no hay transacciones. Añade la primera para empezar.",
  "tx.emptyFiltered": "Ninguna transacción coincide con los filtros actuales.",

  "settings.householdName": "Nombre del hogar",
  "settings.members": "Miembros",
  "settings.inviteMember": "Invitar a un miembro",
  "settings.invite": "Invitar",
  "settings.manage": "Gestionar",
  "settings.categories": "Categorías",
  "settings.baseCurrency": "Moneda predeterminada de la cuenta",
  "settings.baseCurrencyHint": "Moneda predeterminada para las cuentas nuevas. Las cuentas existentes conservan su moneda.",
  "settings.appearance": "Apariencia",
  "settings.appearanceHint": "Elige un tema o sigue la configuración de tu dispositivo.",
  "settings.textSize": "Tamaño del texto",
  "settings.textSizeHint": "Elige un tamaño más grande y táctil o uno más compacto.",
  "settings.language": "Idioma",
  "settings.languageHint": "Traduce la navegación y las pantallas principales. Algunas herramientas avanzadas siguen en inglés.",
  "settings.experimental": "Funciones experimentales",

  "signin.subtitle": "Inicia sesión en tu hogar",
  "signin.google": "Iniciar sesión con Google",
  "signin.inviteOnly": "Solo por invitación. El acceso lo concede un administrador del hogar.",

  "common.clear": "Borrar",

  "txType.debit": "Gasto",
  "txType.credit": "Ingreso",
  "txType.transfer": "Transferencia",

  "accountGroup.Credit": "Crédito",
  "accountGroup.Banking": "Banca",
  "accountGroup.Invested": "Inversión",
  "accountGroup.Locked": "Bloqueado",

  "accountType.Cash": "Efectivo",
  "accountType.Checking": "Corriente",
  "accountType.Savings": "Ahorros",
  "accountType.CC": "Tarjeta de crédito",
  "accountType.Investment": "Inversión",
  "accountType.Roth401k": "Roth 401(k)",
  "accountType.401k": "401(k)",
  "accountType.HSA": "HSA",
  "accountType.Asset-NonLiquid": "Activo ilíquido",
  "accountType.RSU": "RSU",

  "theme.light": "Claro",
  "theme.dark": "Oscuro",
  "theme.system": "Sistema",

  "fontSize.default": "Predeterminado",
  "fontSize.compact": "Compacto",

  "tx.col.date": "Fecha",
  "tx.col.amount": "Importe",
  "tx.col.category": "Categoría",
  "tx.col.account": "Cuenta",
  "tx.col.labels": "Etiquetas",
  "tx.col.type": "Tipo",
  "tx.addMultiple": "Añadir varias",
  "tx.bulkImport": "Importación masiva",
  "tx.uncategorized": "Sin categoría",
  "tx.notInReports": "No en informes",
  "tx.loading": "Cargando transacciones…",
  "tx.loadingMore": "Cargando más…",
  "tx.scrollForMore": "Desplázate para ver más",

  "reports.spend-by-category": "Gasto por categoría",
  "reports.income-spend-savings": "Ingresos vs Gastos",
  "reports.spend-over-time": "Gasto a lo largo del tiempo",
  "reports.period-comparison": "Comparación de periodos",
  "reports.subscriptions": "Suscripciones",
  "reports.chart": "Gráfico",
  "reports.table": "Tabla",
  "reports.total": "Total",
  "reports.average": "Promedio",
  "reports.noSpend": "No hay gastos en este periodo.",

  "period.this-month": "Este mes",
  "period.last-month": "Anterior",
  "period.3m": "3m",
  "period.6m": "6m",
  "period.1y": "1a",
  "period.3y": "3a",
  "period.this-year": "Este año",
  "period.last-year": "Año pasado",
  "period.all": "Todo",
  "period.custom": "Personalizado",

  "accounts.showInactive": "Mostrar inactivas",
  "accounts.hideInactive": "Ocultar inactivas",
  "accounts.editAccount": "Editar cuenta",

  "categories.title": "Categorías",
};

const de: Dict = {
  "nav.transactions": "Transaktionen",
  "nav.reports": "Berichte",
  "nav.accounts": "Konten",
  "nav.settings": "Einstellungen",

  "common.add": "Hinzufügen",
  "common.edit": "Bearbeiten",
  "common.done": "Fertig",
  "common.save": "Speichern",
  "common.cancel": "Abbrechen",
  "common.signOut": "Abmelden",

  "accounts.addAccount": "Konto hinzufügen",
  "accounts.netWorth": "Gesamtvermögen",
  "accounts.empty": "Noch keine Konten. Fügen Sie Ihr erstes Konto hinzu, um Ihren Kontostand zu verfolgen.",

  "tx.searchPlaceholder": "Nach Betrag, Kategorie oder Kommentar suchen...",
  "tx.filter": "Filter",
  "tx.addTransaction": "Transaktion hinzufügen",
  "tx.emptyNoFilters": "Noch keine Transaktionen. Fügen Sie die erste hinzu, um zu beginnen.",
  "tx.emptyFiltered": "Keine Transaktionen entsprechen den aktuellen Filtern.",

  "settings.householdName": "Haushaltsname",
  "settings.members": "Mitglieder",
  "settings.inviteMember": "Mitglied einladen",
  "settings.invite": "Einladen",
  "settings.manage": "Verwalten",
  "settings.categories": "Kategorien",
  "settings.baseCurrency": "Standardwährung für Konten",
  "settings.baseCurrencyHint": "Standardwährung für neue Konten. Bestehende Konten behalten ihre Währung.",
  "settings.appearance": "Darstellung",
  "settings.appearanceHint": "Wählen Sie ein Design oder folgen Sie Ihrer Geräteeinstellung.",
  "settings.textSize": "Textgröße",
  "settings.textSizeHint": "Wählen Sie eine größere, berührungsfreundliche oder eine kompaktere Größe.",
  "settings.language": "Sprache",
  "settings.languageHint": "Übersetzt Navigation und wichtige Ansichten. Einige erweiterte Werkzeuge bleiben auf Englisch.",
  "settings.experimental": "Experimentelle Funktionen",

  "signin.subtitle": "Bei Ihrem Haushalt anmelden",
  "signin.google": "Mit Google anmelden",
  "signin.inviteOnly": "Nur mit Einladung. Der Zugang wird von einem Haushalts-Administrator gewährt.",

  "common.clear": "Löschen",

  "txType.debit": "Ausgabe",
  "txType.credit": "Einnahme",
  "txType.transfer": "Überweisung",

  "accountGroup.Credit": "Kredit",
  "accountGroup.Banking": "Bankkonten",
  "accountGroup.Invested": "Investiert",
  "accountGroup.Locked": "Gesperrt",

  "accountType.Cash": "Bargeld",
  "accountType.Checking": "Girokonto",
  "accountType.Savings": "Sparkonto",
  "accountType.CC": "Kreditkarte",
  "accountType.Investment": "Investition",
  "accountType.Roth401k": "Roth 401(k)",
  "accountType.401k": "401(k)",
  "accountType.HSA": "HSA",
  "accountType.Asset-NonLiquid": "Illiquides Vermögen",
  "accountType.RSU": "RSU",

  "theme.light": "Hell",
  "theme.dark": "Dunkel",
  "theme.system": "System",

  "fontSize.default": "Standard",
  "fontSize.compact": "Kompakt",

  "tx.col.date": "Datum",
  "tx.col.amount": "Betrag",
  "tx.col.category": "Kategorie",
  "tx.col.account": "Konto",
  "tx.col.labels": "Labels",
  "tx.col.type": "Typ",
  "tx.addMultiple": "Mehrere hinzufügen",
  "tx.bulkImport": "Massenimport",
  "tx.uncategorized": "Ohne Kategorie",
  "tx.notInReports": "Nicht in Berichten",
  "tx.loading": "Transaktionen werden geladen…",
  "tx.loadingMore": "Mehr laden…",
  "tx.scrollForMore": "Zum Weiterladen scrollen",

  "reports.spend-by-category": "Ausgaben nach Kategorie",
  "reports.income-spend-savings": "Einnahmen vs. Ausgaben",
  "reports.spend-over-time": "Ausgaben im Zeitverlauf",
  "reports.period-comparison": "Periodenvergleich",
  "reports.subscriptions": "Abonnements",
  "reports.chart": "Diagramm",
  "reports.table": "Tabelle",
  "reports.total": "Gesamt",
  "reports.average": "Durchschnitt",
  "reports.noSpend": "Keine Ausgaben in diesem Zeitraum.",

  "period.this-month": "Dieser Monat",
  "period.last-month": "Letzter",
  "period.3m": "3M",
  "period.6m": "6M",
  "period.1y": "1J",
  "period.3y": "3J",
  "period.this-year": "Dieses Jahr",
  "period.last-year": "Letztes Jahr",
  "period.all": "Gesamte Zeit",
  "period.custom": "Benutzerdef.",

  "accounts.showInactive": "Inaktive anzeigen",
  "accounts.hideInactive": "Inaktive ausblenden",
  "accounts.editAccount": "Konto bearbeiten",

  "categories.title": "Kategorien",
};

const DICTS: Record<Lang, Dict> = { en, uk, es, de };

export function translate(lang: Lang, key: string): string {
  return DICTS[lang]?.[key] ?? en[key] ?? key;
}

// Subscribe a component to the current language; re-renders on change.
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => "en");
}

// Translator hook: const t = useT(); t("nav.accounts").
export function useT(): (key: string) => string {
  const lang = useLang();
  return (key: string) => translate(lang, key);
}
