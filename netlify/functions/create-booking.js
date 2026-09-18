import { useState, useEffect } from "react"
import { addPropertyControls, ControlType } from "framer"

// =============================================================================
// ★ QUICK REFERENCE — the parts you'll most likely want to edit ★
// =============================================================================
//  1. Brand colors & fonts        → "BRAND TOKENS" just below
//  2. Translations / wording      → "TRANSLATIONS" section just below. Every
//     piece of text in the form lives here, one block per language (EN/FR/DE/PT),
//     already translated. Add or edit wording by changing the value after each
//     key — leave the keys themselves alone.
//  3. Available clothing sizes    → SIZE_OPTIONS constant, below TRANSLATIONS
//  4. Turn an add-on on/off       → Framer panel → "Offer clothing / bottle /
//     meals add-on" toggles. Logic lives in the AddOnsStep component below.
//  5. Prices, camp info, dates    → all set from the Framer panel — see the
//     addPropertyControls(...) block at the very bottom of this file.
//  6. Ticket capacity             → "Group size" control, bind it to the same
//     CMS field as your camp page's "Group size". See the "AVAILABILITY"
//     section below for how remaining spots are checked live.
//  7. Desktop vs Phone layout     → "Layout" control at the bottom. Leave on
//     "Auto" to follow real screen width, or force "Desktop"/"Phone" — handy
//     when set per-breakpoint via Framer's own responsive overrides.
//  8. Date / age fields           → three separate date fields (start_date,
//     end_date, start_date_month) and two age fields (start_age, end_age),
//     each binding to its own CMS field directly.
//  9. Clothing tiered pricing     → clothingSetCost() function, just below
//     TRANSLATIONS. 1st set full price, every extra set gets a % discount —
//     both the unit price and the discount % are Framer panel controls.
// =============================================================================

// ---------------------------------------------------------------------------
// BRAND TOKENS
// ---------------------------------------------------------------------------

const COLORS = {
    yellow: "#F9B233",
    white: "#FBFAF8",
    black: "#12110F",
    bg: "#F2EFEA",
    boxFill: "#F7F4EF",
    boxBorder: "#E6E0D8",
}

const RADIUS = 4

const FONT_HEADING = "'Space Grotesk', sans-serif"
const FONT_BODY = "'IBM Plex Sans', sans-serif"

const TEXT = {
    muted: "rgba(18, 17, 15, 0.6)",
    faint: "rgba(18, 17, 15, 0.4)",
}

const AMBER_TEXT = "#8A5C0A"
const ERROR = { text: "#9A2E2E", bg: "rgba(217, 92, 92, 0.1)", border: "rgba(217, 92, 92, 0.35)" }
// Not in the brand palette — a status box needs both a "low" and "ok" state,
// and green/red are the only colors that read unambiguously as a stock
// warning at a glance. Kept muted/low-saturation to match the rest of the UI.
const STATUS_OK = { text: "#2E7D32", bg: "rgba(46, 125, 50, 0.1)", border: "rgba(46, 125, 50, 0.3)" }
const STATUS_LOW = ERROR

// =============================================================================
// ★ TRANSLATIONS — every string the form shows, in one place per language.
// The "en" block is the source of truth for which keys exist; fr / de / pt
// mirror it exactly. Entries written as functions (e.g. subheading: (max) =>
// `...`) build a sentence with a number inserted — if you edit the wording,
// keep the ${...} part so the number keeps inserting correctly.
// =============================================================================

const EN = {
    langLabel: "EN",
    steps: { children: "Children", contact: "Contact", addons: "Add-ons", payment: "Payment" },
    children: {
        heading: "Participants",
        subheading: (max: number) => `Register up to ${max} children in one booking.`,
        childLabel: "Child",
        remove: "Remove",
        firstName: "First name",
        lastName: "Last name",
        dob: "Date of birth",
        club: "Club, if any",
        firstNamePlaceholder: "Léa",
        lastNamePlaceholder: "Weber",
        optional: "Optional",
        requiredError: "Please fill in all required fields marked with *.",
        addAnother: "+ Add another child",
        maxReached: (max: number) => `Maximum of ${max} children per booking. Need more? Contact us directly.`,
        spotsLimited: (n: number) => `Only ${n} spot${n === 1 ? "" : "s"} left for this camp.`,
    },
    contact: {
        heading: "Parent / guardian contact",
        headingShort: "Parent contact",
        subheading: "We will send the confirmation and all necessary information to your email.",
        fullName: "Full name",
        email: "Email",
        phone: "Phone",
    },
    addons: {
        heading: "Add-ons",
        subheading: "Choose your perfect kit and meal per child, and add anything we need to know.",
        closedNotice: (date: string) => `Add-ons closed on ${date}. You can still complete this booking without them.`,
        openNotice: (date: string) => `Add-ons can be added or changed until ${date}.`,
        allergies: "Allergies or medical notes",
        clothingTitle: "Clothing set",
        clothingUnit: "/ set",
        clothingDiscountNote: "20% off every set after the first",
        clothingSubtotal: (qty: number, amount: number) => `Subtotal (${qty} sets): €${amount.toFixed(2)}`,
        bottleTitle: "Drinking bottle",
        bottleDesc: "Reusable, refillable at camp",
        bottleUnit: "/ bottle",
        selectSize: "Select size",
        selectSizeShort: "Size",
        mealsTitle: "Meals (lunch)",
        mealsDesc: "Catered lunch each day, once per child",
        decreaseQty: "Decrease quantity",
        increaseQty: "Increase quantity",
    },
    payment: {
        heading: "Payment",
        subheading: (total: number, count: number) =>
            `You'll be charged €${total} securely via Stripe${count > 1 ? ` for ${count} children` : ""}.`,
        addOnsSkipped: "Add-ons weren't included since the deadline has passed — only the standard ticket is charged.",
    },
    soldOut: {
        heading: "Sold out",
        message: (n: number) => `This camp has reached its group size of ${n}. Get in touch and we'll let you know if a spot opens up.`,
    },
    footer: {
        back: "Back",
        continueBtn: "Continue",
        processing: "Processing…",
        confirmPay: "Confirm & pay",
        stepCount: (i: number, n: number) => `Step ${i} of ${n}`,
    },
    summary: {
        standardTicket: "Standard Ticket",
        child: "child",
        childrenWord: "children",
        addOns: "Add-ons",
        total: "Total",
        agesLabel: "Ages",
        spotsLeft: (remaining: number, total: number) => `${remaining} of ${total} spots left`,
    },
    clothingContents: {
        football: "1 T-shirt + 1 Short",
        basketball: "1 Tanktop + 1 Short",
        volleyball: "2 T-shirts",
    },
    sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
    genericError: "Something went wrong. Please try again.",
}

const FR: typeof EN = {
    langLabel: "FR",
    steps: { children: "Enfants", contact: "Contact", addons: "Options", payment: "Paiement" },
    children: {
        heading: "Participants",
        subheading: (max) => `Inscrivez jusqu'à ${max} enfants en une seule réservation.`,
        childLabel: "Enfant",
        remove: "Supprimer",
        firstName: "Prénom",
        lastName: "Nom de famille",
        dob: "Date de naissance",
        club: "Club, le cas échéant",
        firstNamePlaceholder: "Léa",
        lastNamePlaceholder: "Weber",
        optional: "Facultatif",
        requiredError: "Veuillez remplir tous les champs obligatoires marqués d'un *.",
        addAnother: "+ Ajouter un autre enfant",
        maxReached: (max) => `Maximum de ${max} enfants par réservation. Besoin de plus ? Contactez-nous directement.`,
        spotsLimited: (n) => `Il ne reste que ${n} place${n === 1 ? "" : "s"} pour ce camp.`,
    },
    contact: {
        heading: "Contact parent / tuteur",
        headingShort: "Contact parent",
        subheading: "Nous enverrons la confirmation et toutes les informations nécessaires à votre adresse e-mail.",
        fullName: "Nom complet",
        email: "E-mail",
        phone: "Téléphone",
    },
    addons: {
        heading: "Options",
        subheading: "Choisissez la tenue et le repas idéals pour chaque enfant, et ajoutez toute information utile.",
        closedNotice: (date) => `Les options ont été clôturées le ${date}. Vous pouvez toujours finaliser cette réservation sans elles.`,
        openNotice: (date) => `Les options peuvent être ajoutées ou modifiées jusqu'au ${date}.`,
        allergies: "Allergies ou remarques médicales",
        clothingTitle: "Tenue",
        clothingUnit: "/ ensemble",
        clothingDiscountNote: "20 % de réduction dès le 2e ensemble",
        clothingSubtotal: (qty, amount) => `Sous-total (${qty} ensembles) : ${amount.toFixed(2)} €`,
        bottleTitle: "Gourde",
        bottleDesc: "Réutilisable, rechargeable sur place",
        bottleUnit: "/ gourde",
        selectSize: "Choisir la taille",
        selectSizeShort: "Taille",
        mealsTitle: "Repas (déjeuner)",
        mealsDesc: "Déjeuner fourni chaque jour, une fois par enfant",
        decreaseQty: "Diminuer la quantité",
        increaseQty: "Augmenter la quantité",
    },
    payment: {
        heading: "Paiement",
        subheading: (total, count) =>
            `Vous serez débité de ${total} € en toute sécurité via Stripe${count > 1 ? ` pour ${count} enfants` : ""}.`,
        addOnsSkipped: "Les options n'ont pas été incluses car le délai est dépassé — seul le billet standard est facturé.",
    },
    soldOut: {
        heading: "Complet",
        message: (n) => `Ce camp a atteint sa taille de groupe de ${n}. Contactez-nous, nous vous informerons si une place se libère.`,
    },
    footer: {
        back: "Retour",
        continueBtn: "Continuer",
        processing: "Traitement en cours…",
        confirmPay: "Confirmer et payer",
        stepCount: (i, n) => `Étape ${i} sur ${n}`,
    },
    summary: {
        standardTicket: "Billet standard",
        child: "enfant",
        childrenWord: "enfants",
        addOns: "Options",
        total: "Total",
        agesLabel: "Âge",
        spotsLeft: (remaining, total) => `${remaining} places restantes sur ${total}`,
    },
    clothingContents: {
        football: "1 T-shirt + 1 short",
        basketball: "1 débardeur + 1 short",
        volleyball: "2 T-shirts",
    },
    sports: { football: "Football", basketball: "Basketball", volleyball: "Volleyball" },
    genericError: "Une erreur s'est produite. Veuillez réessayer.",
}

const DE: typeof EN = {
    langLabel: "DE",
    steps: { children: "Kinder", contact: "Kontakt", addons: "Add-ons", payment: "Zahlung" },
    children: {
        heading: "Teilnehmer",
        subheading: (max) => `Melden Sie bis zu ${max} Kinder in einer Buchung an.`,
        childLabel: "Kind",
        remove: "Entfernen",
        firstName: "Vorname",
        lastName: "Nachname",
        dob: "Geburtsdatum",
        club: "Verein, falls vorhanden",
        firstNamePlaceholder: "Léa",
        lastNamePlaceholder: "Weber",
        optional: "Optional",
        requiredError: "Bitte füllen Sie alle mit * markierten Pflichtfelder aus.",
        addAnother: "+ Weiteres Kind hinzufügen",
        maxReached: (max) => `Maximal ${max} Kinder pro Buchung. Mehr benötigt? Kontaktieren Sie uns direkt.`,
        spotsLimited: (n) => `Nur noch ${n} ${n === 1 ? "Platz" : "Plätze"} für dieses Camp verfügbar.`,
    },
    contact: {
        heading: "Kontakt Eltern / Erziehungsberechtigte",
        headingShort: "Elternkontakt",
        subheading: "Wir senden die Bestätigung und alle notwendigen Informationen an Ihre E-Mail-Adresse.",
        fullName: "Vollständiger Name",
        email: "E-Mail",
        phone: "Telefon",
    },
    addons: {
        heading: "Add-ons",
        subheading: "Wählen Sie die passende Ausrüstung und Verpflegung für jedes Kind und teilen Sie uns alles Wichtige mit.",
        closedNotice: (date) => `Add-ons wurden am ${date} geschlossen. Sie können die Buchung trotzdem ohne sie abschließen.`,
        openNotice: (date) => `Add-ons können bis zum ${date} hinzugefügt oder geändert werden.`,
        allergies: "Allergien oder medizinische Hinweise",
        clothingTitle: "Kleidungsset",
        clothingUnit: "/ Set",
        clothingDiscountNote: "Ab dem 2. Set 20% Rabatt",
        clothingSubtotal: (qty, amount) => `Zwischensumme (${qty} Sets): ${amount.toFixed(2)} €`,
        bottleTitle: "Trinkflasche",
        bottleDesc: "Wiederverwendbar, im Camp nachfüllbar",
        bottleUnit: "/ Flasche",
        selectSize: "Größe wählen",
        selectSizeShort: "Größe",
        mealsTitle: "Mahlzeiten (Mittagessen)",
        mealsDesc: "Täglich bereitgestelltes Mittagessen, einmal pro Kind",
        decreaseQty: "Menge verringern",
        increaseQty: "Menge erhöhen",
    },
    payment: {
        heading: "Zahlung",
        subheading: (total, count) =>
            `Ihnen werden sicher ${total} € über Stripe berechnet${count > 1 ? ` für ${count} Kinder` : ""}.`,
        addOnsSkipped: "Add-ons wurden nicht berücksichtigt, da die Frist abgelaufen ist — es wird nur das Standardticket berechnet.",
    },
    soldOut: {
        heading: "Ausgebucht",
        message: (n) => `Dieses Camp hat seine Gruppengröße von ${n} erreicht. Kontaktieren Sie uns, wir informieren Sie, falls ein Platz frei wird.`,
    },
    footer: {
        back: "Zurück",
        continueBtn: "Weiter",
        processing: "Wird verarbeitet…",
        confirmPay: "Bestätigen & bezahlen",
        stepCount: (i, n) => `Schritt ${i} von ${n}`,
    },
    summary: {
        standardTicket: "Standardticket",
        child: "Kind",
        childrenWord: "Kinder",
        addOns: "Add-ons",
        total: "Gesamt",
        agesLabel: "Alter",
        spotsLeft: (remaining, total) => `${remaining} von ${total} Plätzen frei`,
    },
    clothingContents: {
        football: "1 T-Shirt + 1 Short",
        basketball: "1 Tanktop + 1 Short",
        volleyball: "2 T-Shirts",
    },
    sports: { football: "Fußball", basketball: "Basketball", volleyball: "Volleyball" },
    genericError: "Etwas ist schiefgelaufen. Bitte versuchen Sie es erneut.",
}

const PT: typeof EN = {
    langLabel: "PT",
    steps: { children: "Crianças", contact: "Contacto", addons: "Extras", payment: "Pagamento" },
    children: {
        heading: "Participantes",
        subheading: (max) => `Inscreva até ${max} crianças numa única reserva.`,
        childLabel: "Criança",
        remove: "Remover",
        firstName: "Primeiro nome",
        lastName: "Apelido",
        dob: "Data de nascimento",
        club: "Clube, se aplicável",
        firstNamePlaceholder: "Léa",
        lastNamePlaceholder: "Weber",
        optional: "Opcional",
        requiredError: "Por favor, preencha todos os campos obrigatórios marcados com *.",
        addAnother: "+ Adicionar outra criança",
        maxReached: (max) => `Máximo de ${max} crianças por reserva. Precisa de mais? Contacte-nos diretamente.`,
        spotsLimited: (n) => `Restam apenas ${n} vaga${n === 1 ? "" : "s"} para este campo.`,
    },
    contact: {
        heading: "Contacto do encarregado de educação",
        headingShort: "Contacto do responsável",
        subheading: "Enviaremos a confirmação e todas as informações necessárias para o seu e-mail.",
        fullName: "Nome completo",
        email: "E-mail",
        phone: "Telefone",
    },
    addons: {
        heading: "Extras",
        subheading: "Escolha o kit e a refeição ideais para cada criança, e adicione qualquer informação que devamos saber.",
        closedNotice: (date) => `Os extras encerraram a ${date}. Ainda pode concluir esta reserva sem eles.`,
        openNotice: (date) => `Os extras podem ser adicionados ou alterados até ${date}.`,
        allergies: "Alergias ou notas médicas",
        clothingTitle: "Conjunto de roupa",
        clothingUnit: "/ conjunto",
        clothingDiscountNote: "20% de desconto a partir do 2.º conjunto",
        clothingSubtotal: (qty, amount) => `Subtotal (${qty} conjuntos): ${amount.toFixed(2)} €`,
        bottleTitle: "Garrafa de água",
        bottleDesc: "Reutilizável, pode ser reabastecida no campo",
        bottleUnit: "/ garrafa",
        selectSize: "Selecionar tamanho",
        selectSizeShort: "Tamanho",
        mealsTitle: "Refeições (almoço)",
        mealsDesc: "Almoço fornecido todos os dias, uma vez por criança",
        decreaseQty: "Diminuir quantidade",
        increaseQty: "Aumentar quantidade",
    },
    payment: {
        heading: "Pagamento",
        subheading: (total, count) =>
            `Será cobrado ${total} € de forma segura via Stripe${count > 1 ? ` para ${count} crianças` : ""}.`,
        addOnsSkipped: "Os extras não foram incluídos porque o prazo já passou — só é cobrado o bilhete standard.",
    },
    soldOut: {
        heading: "Esgotado",
        message: (n) => `Este campo atingiu o limite de ${n} participantes. Contacte-nos e avisaremos se surgir uma vaga.`,
    },
    footer: {
        back: "Voltar",
        continueBtn: "Continuar",
        processing: "A processar…",
        confirmPay: "Confirmar e pagar",
        stepCount: (i, n) => `Passo ${i} de ${n}`,
    },
    summary: {
        standardTicket: "Bilhete standard",
        child: "criança",
        childrenWord: "crianças",
        addOns: "Extras",
        total: "Total",
        agesLabel: "Idade",
        spotsLeft: (remaining, total) => `${remaining} de ${total} vagas restantes`,
    },
    clothingContents: {
        football: "1 T-shirt + 1 calção",
        basketball: "1 top + 1 calção",
        volleyball: "2 T-shirts",
    },
    sports: { football: "Futebol", basketball: "Basquetebol", volleyball: "Voleibol" },
    genericError: "Ocorreu um erro. Por favor, tente novamente.",
}

const TRANSLATIONS: Record<string, typeof EN> = { en: EN, fr: FR, de: DE, pt: PT }
const LANGUAGES = [
    { code: "en", label: "EN" },
    { code: "fr", label: "FR" },
    { code: "de", label: "DE" },
    { code: "pt", label: "PT" },
]

const SIZE_OPTIONS = ["128", "140", "152", "164", "S", "M"]
const MAX_ADDON_QTY = 5
const MAX_CHILDREN = 5

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepId = "children" | "contact" | "addons" | "payment"

interface ChildAddOns {
    clothingQty: number
    clothingSize: string
    bottleQty: number
    meals: boolean
}

interface Child {
    id: string
    firstName: string
    lastName: string
    dob: string
    club: string
    allergies: string
    addOns: ChildAddOns
}

function newChild(): Child {
    return {
        id: Math.random().toString(36).slice(2),
        firstName: "",
        lastName: "",
        dob: "",
        club: "",
        allergies: "",
        addOns: { clothingQty: 0, clothingSize: "", bottleQty: 0, meals: false },
    }
}

interface FormData {
    children: Child[]
    contact: { parentName: string; email: string; phone: string }
}

const EMPTY_FORM: FormData = {
    children: [newChild()],
    contact: { parentName: "", email: "", phone: "" },
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isChildValid(child: Child) {
    return child.firstName.trim() !== "" && child.lastName.trim() !== "" && child.dob !== ""
}

function isContactValid(contact: FormData["contact"]) {
    return (
        contact.parentName.trim() !== "" &&
        contact.email.trim() !== "" &&
        contact.email.includes("@") &&
        contact.phone.trim() !== ""
    )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function BookingForm(props) {
    const {
        campTitle,
        sport,
        start_date,
        end_date,
        start_date_month,
        location,
        start_age,
        end_age,
        fee,
        onSubmit,
        campStartDate,
        addonsCutoffDays,
        clothingPrice,
        clothingDiscountPercent,
        bottlePrice,
        mealsPrice,
        enableClothing,
        enableBottle,
        enableMeals,
        totalSpots,
        availabilityEndpoint,
        layout,
        defaultLanguage,
    } = props

    const isPhoneLayout = layout === "phone"
    const isDesktopLayout = layout === "desktop"
    const gridStyle = isPhoneLayout ? { ...styles.grid2, gridTemplateColumns: "1fr" } : styles.grid2

    // ★ Real narrow-viewport detection — separate from isPhoneLayout above,
    // which only tracks the explicit "Layout: Phone" override. This tracks
    // actual screen width (same 780px breakpoint the CSS media query uses),
    // for the few things — like shorter phone-only wording — that need real
    // JavaScript logic rather than a CSS rule. "Desktop" always wins even on
    // a narrow window, since that's an explicit override.
    const [isNarrowViewport, setIsNarrowViewport] = useState(false)
    useEffect(() => {
        if (typeof window === "undefined") return
        const mq = window.matchMedia("(max-width: 780px)")
        const update = () => setIsNarrowViewport(mq.matches)
        update()
        mq.addEventListener("change", update)
        return () => mq.removeEventListener("change", update)
    }, [])
    const showPhoneCopy = layout === "phone" || (layout !== "desktop" && isNarrowViewport)

    const dateRangeDisplay = formatDateRange(start_date, end_date, start_date_month)
    const ageRangeDisplay = formatAgeRange(start_age, end_age)
    const feeNum = Number(fee) || 0
    const totalSpotsNum = totalSpots ? parseInt(String(totalSpots), 10) : null

    const [stepIndex, setStepIndex] = useState(0)
    const [data, setData] = useState<FormData>(EMPTY_FORM)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showChildrenErrors, setShowChildrenErrors] = useState(false)
    const [showContactErrors, setShowContactErrors] = useState(false)

    // ★ Language — visitors can switch live via the buttons at the top of the
    // form; "defaultLanguage" from the panel only sets what they see first.
    const [language, setLanguage] = useState(defaultLanguage || "en")
    const t = TRANSLATIONS[language] || TRANSLATIONS.en

    const [spotsRemaining, setSpotsRemaining] = useState<number | null>(null)
    const campKey = `${location} (${sport})`

    useEffect(() => {
        if (!availabilityEndpoint || !totalSpotsNum) return
        const url = `${availabilityEndpoint}?camp=${encodeURIComponent(campKey)}&capacity=${totalSpotsNum}`
        fetch(url)
            .then((r) => r.json())
            .then((d) => {
                if (typeof d.remaining === "number") setSpotsRemaining(d.remaining)
            })
            .catch(() => {
                /* fail open — see AVAILABILITY note */
            })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [availabilityEndpoint, totalSpotsNum, campKey])

    const soldOut = spotsRemaining !== null && spotsRemaining <= 0
    const effectiveMaxChildren =
        spotsRemaining !== null ? Math.max(0, Math.min(MAX_CHILDREN, spotsRemaining)) : MAX_CHILDREN

    const STEPS: { id: StepId; label: string }[] = [
        { id: "children", label: t.steps.children },
        { id: "contact", label: t.steps.contact },
        { id: "addons", label: t.steps.addons },
        { id: "payment", label: t.steps.payment },
    ]
    const currentStep = STEPS[stepIndex]
    const clothingDescription = t.clothingContents[sport] || t.clothingContents.football

    const childrenValid = data.children.every(isChildValid)
    const contactValid = isContactValid(data.contact)

    const cutoffDate = getCutoffDate(campStartDate, addonsCutoffDays)
    const addOnsOpen = cutoffDate ? new Date() <= cutoffDate : true

    const addOnPrices = {
        clothing: clothingPrice ?? 25.9,
        clothingDiscountPercent: clothingDiscountPercent ?? 20,
        bottle: bottlePrice ?? 10,
        meals: mealsPrice ?? 60,
    }

    const campFeesTotal = feeNum * data.children.length
    const addOnLines = addOnsOpen ? buildAddOnLines(data.children, addOnPrices, t) : []
    const addOnsTotal = addOnLines.reduce((sum, l) => sum + l.amount, 0)
    const total = campFeesTotal + addOnsTotal

    function addChild() {
        if (data.children.length >= effectiveMaxChildren) return
        setData((prev) => ({ ...prev, children: [...prev.children, newChild()] }))
    }

    function removeChild(id: string) {
        setData((prev) => ({ ...prev, children: prev.children.filter((c) => c.id !== id) }))
    }

    function updateChild(id: string, field: keyof Child, value: string) {
        setData((prev) => ({
            ...prev,
            children: prev.children.map((c) => (c.id === id ? { ...c, [field]: value } : c)),
        }))
    }

    function updateChildAddOns(id: string, patch: Partial<ChildAddOns>) {
        setData((prev) => ({
            ...prev,
            children: prev.children.map((c) =>
                c.id === id ? { ...c, addOns: { ...c.addOns, ...patch } } : c
            ),
        }))
    }

    function updateContact(field: string, value: string) {
        setData((prev) => ({ ...prev, contact: { ...prev.contact, [field]: value } }))
    }

    function goNext() {
        if (currentStep.id === "children" && !childrenValid) {
            setShowChildrenErrors(true)
            return
        }
        if (currentStep.id === "contact" && !contactValid) {
            setShowContactErrors(true)
            return
        }
        if (stepIndex < STEPS.length - 1) {
            setStepIndex(stepIndex + 1)
        } else {
            handleSubmit()
        }
    }

    function goBack() {
        if (stepIndex > 0) setStepIndex(stepIndex - 1)
    }

    async function handleSubmit() {
        setSubmitting(true)
        setError(null)
        try {
            const res = await fetch(
                onSubmit || "https://your-backend.example.com/api/bookings",
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        camp: campKey,
                        campTitle,
                        children: data.children,
                        contact: data.contact,
                        addOnsIncluded: addOnsOpen,
                        total,
                        totalSpots: totalSpotsNum,
                        language,
                    }),
                }
            )
            if (!res.ok) throw new Error("Submission failed")

            const data = await res.json()
            if (data.checkoutUrl) {
                window.location.href = data.checkoutUrl
                return // keep the button in its "Processing…" state during the redirect
            } else {
                throw new Error("No checkout URL returned")
            }
        } catch (err) {
            setError(t.genericError)
        } finally {
            setSubmitting(false)
        }
    }

    return (
        <div className={`se-booking-form${isPhoneLayout ? " force-phone" : ""}`} style={styles.outerSection}>
            <style>{`
                @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
                .se-booking-form input::placeholder { color: ${TEXT.faint}; }
                .se-booking-form input:focus,
                .se-booking-form input:focus-visible,
                .se-booking-form select:focus {
                    outline: none;
                    border-color: ${COLORS.yellow} !important;
                }
                .se-booking-form input:hover:not(:disabled),
                .se-booking-form select:hover {
                    border-color: ${COLORS.yellow} !important;
                }
                .se-booking-form .add-child-button:hover {
                    border-color: ${COLORS.yellow} !important;
                    color: ${COLORS.black} !important;
                }
                .se-booking-form button.primary:hover { filter: brightness(0.94); }
                .se-booking-form button.primary:disabled { opacity: 0.6; cursor: default; }
                .se-booking-form button.secondary:hover { border-color: ${COLORS.black}; }
                .se-booking-form input[type="checkbox"] { accent-color: ${COLORS.yellow}; }

                @media (max-width: 780px) {
                    .se-booking-form .inner-container { flex-direction: column !important; gap: 16px !important; align-items: stretch !important; width: 100% !important; }
                    .se-booking-form .summary-col { position: static !important; top: auto !important; width: 100% !important; }
                    .se-booking-form .form-col { min-width: 0 !important; width: 100% !important; }
                }
                @media (max-width: 480px) {
                    .se-booking-form .grid-2 { grid-template-columns: 1fr !important; }
                }

                /* ★ Compact phone spacing — applies on real narrow screens (auto
                   mode) AND when "Layout" is forced to "Phone" on the panel.
                   Edit values here; both triggers below stay in sync on purpose. */
                @media (max-width: 780px) {
                    .se-booking-form { padding: 24px !important; }
                    .se-booking-form .child-card,
                    .se-booking-form .addon-card,
                    .se-booking-form .summary-card { width: 100% !important; box-sizing: border-box !important; }
                    .se-booking-form .child-card,
                    .se-booking-form .addon-card { padding: 24px !important; }
                    .se-booking-form .child-card { margin-bottom: 10px !important; }
                    .se-booking-form .addon-card { margin-top: 8px !important; }
                    .se-booking-form .child-card-header { margin-bottom: 8px !important; }
                    .se-booking-form .addon-controls-row { margin-top: 8px !important; }
                    .se-booking-form .field-group { margin-bottom: 12px !important; }
                    .se-booking-form .grid-2 { gap: 12px !important; }
                    .se-booking-form .progress-wrap { margin-bottom: 24px !important; }
                    .se-booking-form .step-heading { margin-bottom: 6px !important; }
                    .se-booking-form .step-subheading { margin-bottom: 14px !important; }
                    .se-booking-form .footer-row { gap: 10px !important; flex-wrap: wrap !important; }
                    .se-booking-form .step-count { flex-basis: 100% !important; margin-top: 6px !important; text-align: center !important; }
                    .se-booking-form .summary-body { padding: 24px !important; }
                    .se-booking-form .summary-divider { margin: 10px 0 !important; }
                    .se-booking-form .add-child-button { padding: 24px !important; }
                }
                .se-booking-form.force-phone { padding: 24px !important; }
                .se-booking-form.force-phone .inner-container { align-items: stretch !important; width: 100% !important; }
                .se-booking-form.force-phone .form-col,
                .se-booking-form.force-phone .summary-col { width: 100% !important; }
                .se-booking-form.force-phone .child-card,
                .se-booking-form.force-phone .addon-card,
                .se-booking-form.force-phone .summary-card { width: 100% !important; box-sizing: border-box !important; }
                .se-booking-form.force-phone .child-card,
                .se-booking-form.force-phone .addon-card { padding: 24px !important; }
                .se-booking-form.force-phone .child-card { margin-bottom: 10px !important; }
                .se-booking-form.force-phone .addon-card { margin-top: 8px !important; }
                .se-booking-form.force-phone .child-card-header { margin-bottom: 8px !important; }
                .se-booking-form.force-phone .addon-controls-row { margin-top: 8px !important; }
                .se-booking-form.force-phone .field-group { margin-bottom: 12px !important; }
                .se-booking-form.force-phone .grid-2 { gap: 12px !important; }
                .se-booking-form.force-phone .progress-wrap { margin-bottom: 24px !important; }
                .se-booking-form.force-phone .step-heading { margin-bottom: 6px !important; }
                .se-booking-form.force-phone .step-subheading { margin-bottom: 14px !important; }
                .se-booking-form.force-phone .footer-row { gap: 10px !important; flex-wrap: wrap !important; }
                .se-booking-form.force-phone .step-count { flex-basis: 100% !important; margin-top: 6px !important; text-align: center !important; }
                .se-booking-form.force-phone .summary-body { padding: 24px !important; }
                .se-booking-form.force-phone .summary-divider { margin: 10px 0 !important; }
                .se-booking-form.force-phone .add-child-button { padding: 24px !important; }
            `}</style>

            <div
                className="inner-container"
                style={{
                    ...styles.innerContainer,
                    ...(isPhoneLayout ? { flexDirection: "column", gap: 16, alignItems: "stretch", width: "100%" } : {}),
                    ...(isDesktopLayout ? { flexDirection: "row" } : {}),
                }}
            >
                {/* LEFT: form */}
                <div
                    className="form-col"
                    style={{ ...styles.formCol, ...(isPhoneLayout ? { minWidth: 0, width: "100%" } : {}) }}
                >
                    <LanguageSwitcher current={language} onChange={setLanguage} />

                    {soldOut ? (
                        <div>
                            <h1 className="step-heading" style={styles.heading}>{t.soldOut.heading}</h1>
                            <p className="step-subheading" style={styles.subheading}>{t.soldOut.message(totalSpotsNum)}</p>
                        </div>
                    ) : (
                        <>
                            <ProgressBar steps={STEPS} activeIndex={stepIndex} />

                            {currentStep.id === "children" && (
                                <ChildrenStep
                                    children={data.children}
                                    onAdd={addChild}
                                    onRemove={removeChild}
                                    onChange={updateChild}
                                    showErrors={showChildrenErrors}
                                    maxChildren={effectiveMaxChildren}
                                    spotsLimited={effectiveMaxChildren < MAX_CHILDREN}
                                    gridStyle={gridStyle}
                                    t={t}
                                />
                            )}
                            {currentStep.id === "contact" && (
                                <ContactStep
                                    data={data.contact}
                                    onChange={updateContact}
                                    showErrors={showContactErrors}
                                    gridStyle={gridStyle}
                                    t={t}
                                    isPhoneLayout={showPhoneCopy}
                                />
                            )}
                            {currentStep.id === "addons" && (
                                <AddOnsStep
                                    children={data.children}
                                    onChange={updateChild}
                                    onAddOnsChange={updateChildAddOns}
                                    addOnsOpen={addOnsOpen}
                                    cutoffDate={cutoffDate}
                                    addOnPrices={addOnPrices}
                                    clothingDescription={clothingDescription}
                                    enableClothing={enableClothing !== false}
                                    enableBottle={enableBottle !== false}
                                    enableMeals={enableMeals !== false}
                                    t={t}
                                    isPhoneLayout={showPhoneCopy}
                                />
                            )}
                            {currentStep.id === "payment" && (
                                <PaymentStep
                                    total={total}
                                    error={error}
                                    childCount={data.children.length}
                                    addOnsTotal={addOnsTotal}
                                    addOnsOpen={addOnsOpen}
                                    t={t}
                                />
                            )}

                            <div className="footer-row" style={styles.footerRow}>
                                {stepIndex > 0 && (
                                    <button className="secondary" style={styles.secondaryButton} onClick={goBack}>
                                        {t.footer.back}
                                    </button>
                                )}
                                <button
                                    className="primary"
                                    style={styles.primaryButton}
                                    onClick={goNext}
                                    disabled={submitting}
                                >
                                    {stepIndex === STEPS.length - 1
                                        ? submitting
                                            ? t.footer.processing
                                            : t.footer.confirmPay
                                        : t.footer.continueBtn}
                                </button>
                                <span className="step-count" style={styles.stepCount}>
                                    {t.footer.stepCount(stepIndex + 1, STEPS.length)}
                                </span>
                            </div>
                        </>
                    )}
                </div>

                {/* RIGHT: sticky camp summary */}
                <div className="summary-col" style={{ ...styles.summaryCol, ...(isPhoneLayout ? { position: "static", top: "auto", width: "100%" } : {}) }}>
                    <div className="summary-card" style={styles.summaryCard}>
                        <div className="summary-body" style={styles.summaryBody}>
                            {sport && <span style={styles.sportBadge}>{(t.sports[sport] || sport).toUpperCase()}</span>}
                            <div style={styles.summaryTitle}>{location}</div>
                            <div style={styles.summaryMeta}>
                                {dateRangeDisplay} · {t.summary.agesLabel} {ageRangeDisplay}
                            </div>
                            {spotsRemaining !== null && (
                                <div
                                    style={{
                                        ...styles.spotsBox,
                                        ...(spotsRemaining <= 10 ? styles.spotsBoxLow : styles.spotsBoxOk),
                                    }}
                                >
                                    {t.summary.spotsLeft(spotsRemaining, totalSpotsNum)}
                                </div>
                            )}
                            <div className="summary-divider" style={styles.divider} />
                            <div style={styles.lineRow}>
                                <span>
                                    {t.summary.standardTicket} × {data.children.length}{" "}
                                    {data.children.length === 1 ? t.summary.child : t.summary.childrenWord}
                                </span>
                                <span>€{campFeesTotal}</span>
                            </div>

                            {addOnLines.length > 0 && (
                                <>
                                    <div className="summary-divider" style={styles.divider} />
                                    <div style={styles.addOnSectionLabel}>{t.summary.addOns}</div>
                                    {addOnLines.map((line, i) => (
                                        <div key={i} style={styles.lineRowSmall}>
                                            <span>{line.label}</span>
                                            <span>€{line.amount}</span>
                                        </div>
                                    ))}
                                </>
                            )}

                            <div className="summary-divider" style={styles.divider} />
                            <div style={styles.totalHighlight}>
                                <div style={styles.totalRow}>
                                    <span>{t.summary.total}</span>
                                    <span>€{total}</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCutoffDate(campStartDate?: string, cutoffDays?: number): Date | null {
    if (!campStartDate) return null
    const start = new Date(campStartDate)
    if (isNaN(start.getTime())) return null
    const days = cutoffDays ?? 7
    const cutoff = new Date(start)
    cutoff.setDate(cutoff.getDate() - days)
    return cutoff
}

function formatDate(d: Date | null): string {
    if (!d) return ""
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })
}

function formatDateRange(start?: string, end?: string, month?: string): string {
    const range = start && end ? `${start}–${end}` : start || end || ""
    return [range, month].filter(Boolean).join(" ")
}

function formatAgeRange(start?: string | number, end?: string | number): string {
    const s = start ?? ""
    const e = end ?? ""
    if (s !== "" && e !== "") return `${s}–${e}`
    return `${s}${e}`
}

// ★ Clothing pricing: the 1st set is full price, every additional set gets
// discountPercent off. E.g. €25.90 first set, then 20% off each extra one.
function clothingSetCost(qty: number, unitPrice: number, discountPercent: number): number {
    if (qty <= 0) return 0
    const discountedUnit = unitPrice * (1 - discountPercent / 100)
    const total = unitPrice + discountedUnit * (qty - 1)
    return Math.round(total * 100) / 100
}

function buildAddOnLines(
    children: Child[],
    prices: { clothing: number; clothingDiscountPercent: number; bottle: number; meals: number },
    t: typeof EN
) {
    const lines: { label: string; amount: number }[] = []
    children.forEach((child, i) => {
        const name = child.firstName || `${t.children.childLabel} ${i + 1}`
        if (child.addOns.clothingQty > 0) {
            const sizeLabel = child.addOns.clothingSize ? ` (${child.addOns.clothingSize})` : ""
            lines.push({
                label: `${name} — ${t.addons.clothingTitle} ×${child.addOns.clothingQty}${sizeLabel}`,
                amount: clothingSetCost(child.addOns.clothingQty, prices.clothing, prices.clothingDiscountPercent),
            })
        }
        if (child.addOns.bottleQty > 0) {
            lines.push({
                label: `${name} — ${t.addons.bottleTitle} ×${child.addOns.bottleQty}`,
                amount: child.addOns.bottleQty * prices.bottle,
            })
        }
        if (child.addOns.meals) {
            lines.push({ label: `${name} — ${t.addons.mealsTitle}`, amount: prices.meals })
        }
    })
    return lines
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function LanguageSwitcher({ current, onChange }) {
    return (
        <div style={styles.langSwitcher}>
            {LANGUAGES.map((l) => (
                <button
                    key={l.code}
                    type="button"
                    onClick={() => onChange(l.code)}
                    style={{
                        ...styles.langButton,
                        ...(current === l.code ? styles.langButtonActive : {}),
                    }}
                >
                    {l.label}
                </button>
            ))}
        </div>
    )
}

function ProgressBar({ steps, activeIndex }) {
    return (
        <div className="progress-wrap" style={styles.progressWrap}>
            {steps.map((step, i) => (
                <div key={step.id} style={{ flex: 1 }}>
                    <div
                        style={{
                            ...styles.progressBar,
                            background: i <= activeIndex ? COLORS.yellow : COLORS.boxBorder,
                        }}
                    />
                    <div
                        style={{
                            ...styles.progressLabel,
                            color: i === activeIndex ? COLORS.black : TEXT.faint,
                        }}
                    >
                        {step.label.toUpperCase()}
                    </div>
                </div>
            ))}
        </div>
    )
}

function Field({ label, value, onChange, placeholder, type = "text", required = false, invalid = false }) {
    return (
        <div className="field-group" style={{ marginBottom: 20 }}>
            <label style={styles.label}>
                {label}
                {required && <span style={styles.requiredMark}> *</span>}
            </label>
            <input
                type={type}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(e.target.value)}
                style={{ ...styles.input, ...(invalid ? styles.inputInvalid : {}) }}
            />
        </div>
    )
}

function QuantityStepper({ value, onChange, max = MAX_ADDON_QTY, t }) {
    return (
        <div style={styles.stepper}>
            <button
                type="button"
                style={styles.stepperBtn}
                onClick={() => onChange(Math.max(0, value - 1))}
                aria-label={t.addons.decreaseQty}
            >
                −
            </button>
            <span style={styles.stepperValue}>{value}</span>
            <button
                type="button"
                style={styles.stepperBtn}
                onClick={() => onChange(Math.min(max, value + 1))}
                aria-label={t.addons.increaseQty}
            >
                +
            </button>
        </div>
    )
}

function ChildrenStep({ children, onAdd, onRemove, onChange, showErrors, maxChildren, spotsLimited, gridStyle, t }) {
    return (
        <div>
            <h1 className="step-heading" style={styles.heading}>{t.children.heading}</h1>
            <p className="step-subheading" style={styles.subheading}>{t.children.subheading(MAX_CHILDREN)}</p>

            {showErrors && !children.every(isChildValid) && (
                <div style={styles.errorBox}>{t.children.requiredError}</div>
            )}

            {children.map((child, index) => (
                <div key={child.id} className="child-card" style={styles.childCard}>
                    <div className="child-card-header" style={styles.childCardHeader}>
                        <span style={styles.childCardTitle}>
                            {t.children.childLabel} {index + 1}
                        </span>
                        {children.length > 1 && (
                            <button style={styles.removeLink} onClick={() => onRemove(child.id)}>
                                {t.children.remove}
                            </button>
                        )}
                    </div>
                    <div className="grid-2" style={gridStyle}>
                        <Field
                            label={t.children.firstName}
                            value={child.firstName}
                            onChange={(v) => onChange(child.id, "firstName", v)}
                            placeholder={t.children.firstNamePlaceholder}
                            required
                            invalid={showErrors && child.firstName.trim() === ""}
                        />
                        <Field
                            label={t.children.lastName}
                            value={child.lastName}
                            onChange={(v) => onChange(child.id, "lastName", v)}
                            placeholder={t.children.lastNamePlaceholder}
                            required
                            invalid={showErrors && child.lastName.trim() === ""}
                        />
                        <Field
                            label={t.children.dob}
                            type="date"
                            value={child.dob}
                            onChange={(v) => onChange(child.id, "dob", v)}
                            required
                            invalid={showErrors && child.dob === ""}
                        />
                        <Field
                            label={t.children.club}
                            value={child.club}
                            onChange={(v) => onChange(child.id, "club", v)}
                            placeholder={t.children.optional}
                        />
                    </div>
                </div>
            ))}

            {children.length < maxChildren ? (
                <button className="add-child-button" style={styles.addChildButton} onClick={onAdd}>
                    {t.children.addAnother}
                </button>
            ) : spotsLimited ? (
                <p style={styles.maxNote}>{t.children.spotsLimited(maxChildren)}</p>
            ) : (
                <p style={styles.maxNote}>{t.children.maxReached(MAX_CHILDREN)}</p>
            )}
        </div>
    )
}

function ContactStep({ data, onChange, showErrors, gridStyle, t, isPhoneLayout }) {
    const invalid = showErrors && !isContactValid(data)
    return (
        <div>
            <h1 className="step-heading" style={styles.heading}>
                {isPhoneLayout ? t.contact.headingShort : t.contact.heading}
            </h1>
            <p className="step-subheading" style={styles.subheading}>{t.contact.subheading}</p>

            {invalid && <div style={styles.errorBox}>{t.children.requiredError}</div>}

            <Field
                label={t.contact.fullName}
                value={data.parentName}
                onChange={(v) => onChange("parentName", v)}
                required
                invalid={showErrors && data.parentName.trim() === ""}
            />
            <div className="grid-2" style={gridStyle}>
                <Field
                    label={t.contact.email}
                    type="email"
                    value={data.email}
                    onChange={(v) => onChange("email", v)}
                    required
                    invalid={showErrors && (data.email.trim() === "" || !data.email.includes("@"))}
                />
                <Field
                    label={t.contact.phone}
                    type="tel"
                    value={data.phone}
                    onChange={(v) => onChange("phone", v)}
                    required
                    invalid={showErrors && data.phone.trim() === ""}
                />
            </div>
        </div>
    )
}

function AddOnsStep({
    children,
    onChange,
    onAddOnsChange,
    addOnsOpen,
    cutoffDate,
    addOnPrices,
    clothingDescription,
    enableClothing,
    enableBottle,
    enableMeals,
    t,
    isPhoneLayout,
}) {
    return (
        <div>
            <h1 className="step-heading" style={styles.heading}>{t.addons.heading}</h1>
            <p className="step-subheading" style={styles.subheading}>{t.addons.subheading}</p>

            {!addOnsOpen && (
                <div style={styles.noticeBox}>{t.addons.closedNotice(formatDate(cutoffDate))}</div>
            )}
            {addOnsOpen && cutoffDate && (
                <div style={styles.mutedNote}>{t.addons.openNotice(formatDate(cutoffDate))}</div>
            )}

            {children.map((child, index) => (
                <div key={child.id} className="child-card" style={styles.childCard}>
                    <div style={styles.childCardTitle}>
                        {child.firstName || `${t.children.childLabel} ${index + 1}`}
                    </div>

                    <Field
                        label={t.addons.allergies}
                        value={child.allergies}
                        onChange={(v) => onChange(child.id, "allergies", v)}
                        placeholder={t.children.optional}
                    />

                    {enableClothing && (
                        <div className="addon-card" style={{ ...styles.addOnCard, opacity: addOnsOpen ? 1 : 0.45 }}>
                            <div style={styles.addOnHeader}>
                                <div>
                                    <div style={styles.addOnTitle}>{t.addons.clothingTitle}</div>
                                    <div style={styles.addOnDesc}>{clothingDescription}</div>
                                    <div style={styles.addOnDiscountNote}>{t.addons.clothingDiscountNote}</div>
                                </div>
                                <div style={styles.addOnPrice}>
                                    €{addOnPrices.clothing}
                                    <span style={styles.addOnPriceUnit}> {t.addons.clothingUnit}</span>
                                </div>
                            </div>
                            <div className="addon-controls-row" style={styles.addOnControlsRow}>
                                <QuantityStepper
                                    value={child.addOns.clothingQty}
                                    onChange={(v) =>
                                        onAddOnsChange(child.id, {
                                            clothingQty: v,
                                            clothingSize: v === 0 ? "" : child.addOns.clothingSize,
                                        })
                                    }
                                    t={t}
                                />
                                {addOnsOpen && child.addOns.clothingQty > 0 && (
                                    <select
                                        value={child.addOns.clothingSize}
                                        onChange={(e) =>
                                            onAddOnsChange(child.id, { clothingSize: e.target.value })
                                        }
                                        style={styles.select}
                                    >
                                        <option value="">{isPhoneLayout ? t.addons.selectSizeShort : t.addons.selectSize}</option>
                                        {SIZE_OPTIONS.map((s) => (
                                            <option key={s} value={s}>
                                                {s}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            {child.addOns.clothingQty >= 2 && (
                                <div style={styles.addOnSubtotal}>
                                    {t.addons.clothingSubtotal(
                                        child.addOns.clothingQty,
                                        clothingSetCost(child.addOns.clothingQty, addOnPrices.clothing, addOnPrices.clothingDiscountPercent)
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {enableBottle && (
                        <div className="addon-card" style={{ ...styles.addOnCard, opacity: addOnsOpen ? 1 : 0.45 }}>
                            <div style={styles.addOnHeader}>
                                <div>
                                    <div style={styles.addOnTitle}>{t.addons.bottleTitle}</div>
                                    <div style={styles.addOnDesc}>{t.addons.bottleDesc}</div>
                                </div>
                                <div style={styles.addOnPrice}>
                                    €{addOnPrices.bottle}
                                    <span style={styles.addOnPriceUnit}> {t.addons.bottleUnit}</span>
                                </div>
                            </div>
                            <div className="addon-controls-row" style={styles.addOnControlsRow}>
                                <QuantityStepper
                                    value={child.addOns.bottleQty}
                                    onChange={(v) => onAddOnsChange(child.id, { bottleQty: v })}
                                    t={t}
                                />
                            </div>
                        </div>
                    )}

                    {enableMeals && (
                        <label
                            className="addon-card"
                            style={{
                                ...styles.addOnCard,
                                ...styles.addOnHeader,
                                cursor: addOnsOpen ? "pointer" : "not-allowed",
                                opacity: addOnsOpen ? 1 : 0.45,
                                marginBottom: 0,
                            }}
                        >
                            <div>
                                <div style={styles.addOnTitle}>{t.addons.mealsTitle}</div>
                                <div style={styles.addOnDesc}>{t.addons.mealsDesc}</div>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                                <span style={styles.addOnPrice}>€{addOnPrices.meals}</span>
                                <input
                                    type="checkbox"
                                    checked={child.addOns.meals && addOnsOpen}
                                    disabled={!addOnsOpen}
                                    onChange={(e) => onAddOnsChange(child.id, { meals: e.target.checked })}
                                    style={{ width: 16, height: 16 }}
                                />
                            </div>
                        </label>
                    )}
                </div>
            ))}
        </div>
    )
}

function PaymentStep({ total, error, childCount, addOnsTotal, addOnsOpen, t }) {
    return (
        <div>
            <h1 className="step-heading" style={styles.heading}>{t.payment.heading}</h1>
            <p className="step-subheading" style={styles.subheading}>{t.payment.subheading(total, childCount)}</p>
            {!addOnsOpen && addOnsTotal === 0 && (
                <div style={styles.mutedNote}>{t.payment.addOnsSkipped}</div>
            )}
            {error && <div style={styles.errorBox}>{error}</div>}
        </div>
    )
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
    outerSection: {
        background: COLORS.bg,
        width: "100%",
        padding: "72px 24px",
        fontFamily: FONT_BODY,
        boxSizing: "border-box",
    },
    innerContainer: {
        maxWidth: 1100,
        margin: "0 auto",
        display: "flex",
        gap: 56,
        alignItems: "flex-start",
    },
    formCol: { flex: 1.3, minWidth: 320 },
    summaryCol: { flex: 1, position: "sticky", top: 40 },
    langSwitcher: { display: "flex", gap: 4, marginBottom: 28 },
    langButton: {
        background: "transparent",
        border: `1px solid ${COLORS.boxBorder}`,
        borderRadius: 999,
        padding: "6px 14px",
        fontFamily: FONT_BODY,
        fontSize: 12,
        fontWeight: 600,
        color: TEXT.muted,
        cursor: "pointer",
    },
    langButtonActive: {
        background: COLORS.black,
        borderColor: COLORS.black,
        color: COLORS.yellow,
    },
    progressWrap: { display: "flex", gap: 8, marginBottom: 44 },
    progressBar: { height: 3, borderRadius: 2, marginBottom: 10 },
    progressLabel: { fontFamily: FONT_BODY, fontSize: 11, fontWeight: 600, letterSpacing: "0.06em" },
    heading: {
        fontFamily: FONT_HEADING,
        fontSize: 34,
        fontWeight: 700,
        letterSpacing: "-0.01em",
        color: COLORS.black,
        margin: "0 0 10px",
    },
    subheading: {
        fontFamily: FONT_BODY,
        fontSize: 15,
        fontWeight: 400,
        color: TEXT.muted,
        margin: "0 0 28px",
        lineHeight: 1.5,
    },
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 },
    label: {
        display: "block",
        fontFamily: FONT_BODY,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: COLORS.black,
        marginBottom: 8,
    },
    requiredMark: { color: ERROR.text },
    input: {
        width: "100%",
        boxSizing: "border-box",
        padding: "12px 14px",
        borderRadius: RADIUS,
        border: `1px solid ${COLORS.boxBorder}`,
        background: COLORS.white,
        color: COLORS.black,
        fontFamily: FONT_BODY,
        fontSize: 15,
    },
    inputInvalid: {
        borderColor: ERROR.border,
        background: "rgba(217, 92, 92, 0.04)",
    },
    select: {
        padding: "10px 12px",
        borderRadius: RADIUS,
        border: `1px solid ${COLORS.boxBorder}`,
        background: COLORS.white,
        color: COLORS.black,
        fontFamily: FONT_BODY,
        fontSize: 14,
    },
    footerRow: { display: "flex", alignItems: "center", gap: 16, marginTop: 12 },
    primaryButton: {
        background: COLORS.yellow,
        color: COLORS.black,
        border: "none",
        borderRadius: 999,
        padding: "13px 26px",
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 14,
        cursor: "pointer",
        transition: "filter 0.15s",
    },
    secondaryButton: {
        background: "transparent",
        border: `1px solid ${COLORS.boxBorder}`,
        borderRadius: 999,
        padding: "13px 22px",
        color: COLORS.black,
        fontFamily: FONT_BODY,
        fontWeight: 500,
        fontSize: 14,
        cursor: "pointer",
        transition: "border-color 0.15s",
    },
    stepCount: { fontFamily: FONT_BODY, fontSize: 13, color: TEXT.faint },
    summaryCard: {
        border: `1px solid ${COLORS.boxBorder}`,
        borderRadius: RADIUS,
        overflow: "hidden",
        background: COLORS.boxFill,
    },
    sportBadge: {
        display: "inline-block",
        background: COLORS.boxFill,
        border: `1px solid ${COLORS.boxBorder}`,
        color: COLORS.black,
        fontFamily: FONT_BODY,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        padding: "6px 12px",
        borderRadius: 999,
        marginBottom: 12,
    },
    summaryBody: { padding: 28 },
    summaryTitle: {
        fontFamily: FONT_HEADING,
        fontSize: 22,
        fontWeight: 700,
        color: COLORS.black,
        marginBottom: 8,
    },
    summaryMeta: { fontFamily: FONT_BODY, fontSize: 14, color: TEXT.muted, marginBottom: 2 },
    spotsBox: {
        fontFamily: FONT_BODY,
        fontSize: 13,
        fontWeight: 600,
        padding: "8px 12px",
        borderRadius: RADIUS,
        border: "1px solid",
        marginTop: 10,
    },
    spotsBoxLow: {
        color: STATUS_LOW.text,
        background: STATUS_LOW.bg,
        borderColor: STATUS_LOW.border,
    },
    spotsBoxOk: {
        color: STATUS_OK.text,
        background: STATUS_OK.bg,
        borderColor: STATUS_OK.border,
    },
    divider: { borderTop: `1px solid ${COLORS.boxBorder}`, margin: "18px 0" },
    addOnSectionLabel: {
        fontFamily: FONT_BODY,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: TEXT.faint,
        marginBottom: 10,
    },
    lineRow: {
        display: "flex",
        justifyContent: "space-between",
        fontFamily: FONT_BODY,
        fontSize: 14,
        color: COLORS.black,
        marginBottom: 8,
    },
    lineRowSmall: {
        display: "flex",
        justifyContent: "space-between",
        fontFamily: FONT_BODY,
        fontSize: 13,
        color: TEXT.muted,
        marginBottom: 6,
    },
    totalHighlight: {
        background: "rgba(249, 178, 51, 0.16)",
        borderRadius: RADIUS,
        padding: "14px 16px",
    },
    totalRow: {
        display: "flex",
        justifyContent: "space-between",
        fontFamily: FONT_HEADING,
        fontSize: 18,
        fontWeight: 700,
        color: COLORS.black,
    },
    errorBox: {
        background: ERROR.bg,
        color: ERROR.text,
        border: `1px solid ${ERROR.border}`,
        padding: "12px 16px",
        borderRadius: RADIUS,
        fontFamily: FONT_BODY,
        fontSize: 14,
        marginBottom: 20,
    },
    childCard: {
        border: `1px solid ${COLORS.boxBorder}`,
        background: COLORS.boxFill,
        borderRadius: RADIUS,
        padding: 24,
        marginBottom: 16,
    },
    childCardHeader: {
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 16,
    },
    childCardTitle: {
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 12,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: COLORS.black,
        marginBottom: 12,
    },
    removeLink: {
        background: "none",
        border: "none",
        color: ERROR.text,
        fontFamily: FONT_BODY,
        fontSize: 13,
        fontWeight: 600,
        cursor: "pointer",
        padding: 0,
    },
    addChildButton: {
        background: "none",
        border: `1px dashed ${COLORS.boxBorder}`,
        borderRadius: RADIUS,
        width: "100%",
        padding: "14px",
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 14,
        color: TEXT.muted,
        cursor: "pointer",
        marginBottom: 8,
    },
    maxNote: { fontFamily: FONT_BODY, fontSize: 13, color: TEXT.faint, marginTop: 8 },
    noticeBox: {
        background: "rgba(249, 178, 51, 0.14)",
        border: "1px solid rgba(249, 178, 51, 0.4)",
        color: AMBER_TEXT,
        padding: "14px 16px",
        borderRadius: RADIUS,
        fontFamily: FONT_BODY,
        fontSize: 14,
        marginBottom: 20,
        lineHeight: 1.5,
    },
    mutedNote: {
        fontFamily: FONT_BODY,
        fontSize: 13,
        color: TEXT.faint,
        marginBottom: 20,
        lineHeight: 1.5,
    },
    addOnCard: {
        border: `1px solid ${COLORS.boxBorder}`,
        background: COLORS.white,
        borderRadius: RADIUS,
        padding: 16,
        marginTop: 12,
        display: "block",
    },
    addOnHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
    addOnTitle: {
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 14,
        color: COLORS.black,
        marginBottom: 3,
    },
    addOnDesc: { fontFamily: FONT_BODY, fontSize: 12, color: TEXT.muted },
    addOnDiscountNote: {
        fontFamily: FONT_BODY,
        fontSize: 11.5,
        fontWeight: 600,
        color: AMBER_TEXT,
        marginTop: 4,
    },
    addOnSubtotal: {
        fontFamily: FONT_BODY,
        fontSize: 12,
        fontWeight: 600,
        color: COLORS.black,
        marginTop: 10,
        paddingTop: 10,
        borderTop: `1px dashed ${COLORS.boxBorder}`,
    },
    addOnPrice: {
        fontFamily: FONT_BODY,
        fontWeight: 600,
        fontSize: 14,
        color: COLORS.black,
        whiteSpace: "nowrap",
    },
    addOnPriceUnit: { fontWeight: 400, color: TEXT.muted, fontSize: 12 },
    addOnControlsRow: { display: "flex", alignItems: "center", gap: 12, marginTop: 14 },
    stepper: {
        display: "flex",
        alignItems: "center",
        border: `1px solid ${COLORS.boxBorder}`,
        borderRadius: RADIUS,
        overflow: "hidden",
    },
    stepperBtn: {
        background: COLORS.boxFill,
        border: "none",
        width: 32,
        height: 32,
        fontSize: 16,
        fontFamily: FONT_BODY,
        color: COLORS.black,
        cursor: "pointer",
    },
    stepperValue: {
        width: 32,
        textAlign: "center",
        fontFamily: FONT_BODY,
        fontSize: 14,
        fontWeight: 600,
        color: COLORS.black,
    },
}

// =============================================================================
// ★ PROPERTY CONTROLS — everything editable from the Framer right-hand panel.
// Bind campTitle / sport / start_date / end_date / start_date_month /
// location / start_age / end_age / fee to your Camps CMS fields ONCE on the
// template page — every camp page then fills in automatically.
// =============================================================================

addPropertyControls(BookingForm, {
    campTitle: {
        type: ControlType.String,
        title: "Camp title",
        defaultValue: "Football",
        description: "Internal reference only (used in order records) — not shown; the visible heading uses Location.",
    },
    sport: {
        type: ControlType.Enum,
        title: "Sport",
        options: ["football", "basketball", "volleyball"],
        optionTitles: ["Football", "Basketball", "Volleyball"],
        defaultValue: "football",
    },

    // ★ Date fields — bind each to its own CMS date field.
    start_date: { type: ControlType.String, title: "Start date", defaultValue: "20" },
    end_date: { type: ControlType.String, title: "End date", defaultValue: "24" },
    start_date_month: { type: ControlType.String, title: "Month", defaultValue: "October" },

    location: { type: ControlType.String, title: "Location", defaultValue: "Bettembourg" },

    // ★ Age fields — bind each to its own CMS field. Plain text to match a
    // text field in your CMS.
    start_age: { type: ControlType.String, title: "Start age", defaultValue: "8" },
    end_age: { type: ControlType.String, title: "End age", defaultValue: "15" },

    // ★ Now plain text, to match a text field in your CMS. Digits only
    // (e.g. "220") — the € sign is added automatically in the UI.
    fee: { type: ControlType.String, title: "Standard ticket price (€)", defaultValue: "220" },

    onSubmit: { type: ControlType.String, title: "Submit endpoint URL" },

    campStartDate: {
        type: ControlType.String,
        title: "Camp start date",
        placeholder: "2026-10-20",
        description: "ISO format YYYY-MM-DD. Used to calculate the add-ons cutoff.",
    },
    addonsCutoffDays: {
        type: ControlType.Number,
        title: "Add-ons close (days before)",
        defaultValue: 7,
        min: 0,
        max: 60,
    },

    // ★ Add-on on/off switches — hide any add-on this camp doesn't offer.
    enableClothing: { type: ControlType.Boolean, title: "Offer clothing add-on", defaultValue: true },
    enableBottle: { type: ControlType.Boolean, title: "Offer bottle add-on", defaultValue: true },
    enableMeals: { type: ControlType.Boolean, title: "Offer meals add-on", defaultValue: true },

    // ★ Now plain text, to match a text field in your CMS. Digits only
    // (e.g. "48") — parsed to a number internally for the capacity math.
    // Leave "Availability check URL" empty to disable live capacity checking.
    totalSpots: {
        type: ControlType.String,
        title: "Group size (total spots)",
        defaultValue: "48",
    },
    availabilityEndpoint: {
        type: ControlType.String,
        title: "Availability check URL",
        placeholder: "https://your-backend.example.com/api/camp-availability",
    },

    clothingPrice: { type: ControlType.Number, title: "Clothing price, 1st set (€)", defaultValue: 25.9 },
    clothingDiscountPercent: {
        type: ControlType.Number,
        title: "Discount from 2nd set (%)",
        defaultValue: 20,
        min: 0,
        max: 100,
    },
    bottlePrice: { type: ControlType.Number, title: "Bottle price (€ / bottle)", defaultValue: 10 },
    mealsPrice: { type: ControlType.Number, title: "Meals price (€)", defaultValue: 60 },

    // ★ Layout override — leave "Auto" and the form adapts to real screen
    // width on its own. Set "Desktop" or "Phone" to force that layout
    // regardless of width — most useful when set per-breakpoint using
    // Framer's own responsive override controls on this component instance.
    layout: {
        type: ControlType.Enum,
        title: "Layout",
        options: ["auto", "desktop", "phone"],
        optionTitles: ["Auto (screen width)", "Desktop", "Phone"],
        defaultValue: "auto",
    },

    // ★ Which language the form opens in. Visitors can still switch it live
    // using the EN / FR / DE / PT buttons at the top of the form.
    defaultLanguage: {
        type: ControlType.Enum,
        title: "Default language",
        options: ["en", "fr", "de", "pt"],
        optionTitles: ["English", "French", "German", "Portuguese"],
        defaultValue: "en",
    },
})
