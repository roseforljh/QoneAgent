// Isolated Codex 26.928 color functions. Reproduce with extract-appearance-evidence.ts.
function pYi(){return(pYi=e((()=>{pK={blue:`#3566f0`,green:`#19b79e`,yellow:`#fdcd54`,pink:`#fa70ab`,orange:`#ff8771`,purple:`#ab5eff`,black:`#000000`}})))()}

function U0i(e,t,n,r){let i=n===`browser`?V0i[t]:qK[t],a={accent:J0i(e?.accent)??i.accent,accentSource:e?.accentSource??((n===`browser`||n===`electron`)&&(e==null||e.contrast===i.contrast&&e.ink===i.ink&&e.surface===i.surface&&e.accent===i.accent)?`chatgpt`:void 0),contrast:W0i(e?.contrast,i.contrast),fonts:G0i(e?.fonts),ink:J0i(e?.ink)??i.ink,opaqueWindows:e?.opaqueWindows??i.opaqueWindows,semanticColors:K0i(e?.semanticColors,i.semanticColors),surface:J0i(e?.surface)??i.surface};return a.accentSource===`chatgpt`&&(n===`browser`||n===`electron`&&r!=null)?{...a,accent:r??V0i[t].accent}:a}

function W0i(e,t){return e==null||Number.isNaN(e)?t:Math.min(100,Math.max(0,Math.round(e)))}

function Y0i(){return(Y0i=e((()=>{H0i(),qK={dark:{accent:`#339cff`,contrast:60,fonts:{code:null,ui:null},ink:`#ffffff`,opaqueWindows:!1,semanticColors:{diffAdded:`#40c977`,diffRemoved:`#fa423e`,skill:`#ad7bf9`},surface:`#181818`},light:{accent:`#339cff`,contrast:45,fonts:{code:null,ui:null},ink:`#1a1c1f`,opaqueWindows:!1,semanticColors:{diffAdded:`#00a240`,diffRemoved:`#ba2623`,skill:`#924ff7`},surface:`#ffffff`}}})))()}

function W2i(e,t,n=!0){let r=t===`dark`,i=e==="default"||e===`black`,a=X2i[i?`blue`:e],o=r?`#ffffff`:`#000000`,s=500;e===`yellow`?s=r?400:600:r&&(e===`pink`||e===`orange`)&&(s=400);let c=r?`${a[400]}${e===`yellow`?`80`:`99`}`:`${a[300]}59`;e==="default"?c=r?`${a[200]}66`:`${a[300]}59`:e===`black`&&(c=r?`#41414166`:`#afafaf66`);let l=a[r?700:50],u=a[r?25:900];(i||!n)&&(l=r?`rgb(50 50 50 / 85%)`:`rgb(233 233 233 / 50%)`,u=r?`#ffffff`:`#0d0d0d`),e===`black`&&!r&&(l=`#000000`,u=`#ffffff`);let d=r?`#734615`:`#fcefbe`;return{accent:a[e===`purple`?300:400],text:a[s],soft:a[r?800:50],submitBackground:i?o:a[r&&e!==`pink`?500:400],submitText:i&&r?`#000000`:`#ffffff`,userMessageBackground:l,userMessageText:u,selection:c,attributionHighlight:e==="default"?d:c}}

function G2i(e,t){return e==="default"||e===`black`?W2i(e,t).submitBackground:pK[e]}

function Z2i(){return(Z2i=e((()=>{pYi(),BCe(),X2i={blue:{25:`#f6fafe`,50:`#e8f3fe`,200:`#63a8f8`,300:`#539af8`,400:`#3a83f7`,500:`#2c67c5`,600:`#1f4e94`,700:`#173e76`,800:`#133463`,900:`#0c274a`},green:{25:`#effaf3`,50:`#def3e5`,200:`#83d197`,300:`#6bc67f`,400:`#53b559`,500:`#48a04c`,600:`#3a843f`,700:`#2c6732`,800:`#1f4e25`,900:`#14361a`},yellow:{25:`#fefbee`,50:`#fdf6dc`,200:`#f9dc78`,300:`#f8d45d`,400:`#f6c543`,500:`#d9a337`,600:`#b8802b`,700:`#95611f`,800:`#734615`,900:`#51300c`},pink:{25:`#fef8fb`,50:`#fdedf4`,200:`#f8a6c8`,300:`#f68ebc`,400:`#f077af`,500:`#cf6194`,600:`#ab4f7a`,700:`#873e60`,800:`#663049`,900:`#462132`},orange:{25:`#fdf5f1`,50:`#fbe8db`,200:`#f1a275`,300:`#ef8b57`,400:`#ee7c37`,500:`#d25e28`,600:`#ac4f23`,700:`#87401d`,800:`#653218`,900:`#45240d`},purple:{25:`#f8f5fd`,50:`#ede5fc`,200:`#b897f4`,300:`#a67df2`,400:`#8952ee`,500:`#7849d1`,600:`#643cae`,700:`#4e2f88`,800:`#3b2366`,900:`#291947`}}})))()}

function c4i(e,t){let n=p4i(e.contrast,t),r=g4i(e.surface),i=g4i(e.ink);return{accent:g4i(e.accent),contrast:n,editorBackground:t===`light`?tq(r,iq,.12):tq(r,i,.07),ink:i,surface:r,surfaceUnder:m4i(e,r,i,t),theme:e,variant:t}}

function u4i(e){let t=tq(e.surface,iq,.09+e.contrast*.04),n=tq(e.surface,iq,.08+e.contrast*.08),r=tq(e.surface,iq,.16+e.contrast*.12);return{accentBackground:eq(e.surface,e.accent,.11+e.contrast*.04),accentBackgroundActive:eq(e.surface,e.accent,.13+e.contrast*.05),accentBackgroundHover:eq(e.surface,e.accent,.12+e.contrast*.045),border:$K(e.ink,.06+e.contrast*.04),borderFocus:e.theme.accent,borderHeavy:$K(e.ink,.09+e.contrast*.06),borderLight:$K(e.ink,.04+e.contrast*.02),buttonPrimaryBackground:e.theme.ink,buttonPrimaryBackgroundActive:$K(e.ink,.1+e.contrast*.12),buttonPrimaryBackgroundHover:$K(e.ink,.05+e.contrast*.06),buttonPrimaryBackgroundInactive:$K(e.ink,.18+e.contrast*.14),buttonSecondaryBackground:$K(e.ink,.04+e.contrast*.02),buttonSecondaryBackgroundActive:$K(e.ink,.03+e.contrast*.02),buttonSecondaryBackgroundHover:$K(e.ink,.04+e.contrast*.03),buttonSecondaryBackgroundInactive:$K(e.ink,.01+e.contrast*.02),buttonTertiaryBackground:$K(e.ink,0),buttonTertiaryBackgroundActive:$K(e.ink,.16+e.contrast*.08),buttonTertiaryBackgroundHover:$K(e.ink,.08+e.contrast*.04),controlBackground:$K(t,.96),controlBackgroundOpaque:nq(t),elevatedPrimary:$K(r,.96),elevatedPrimaryOpaque:nq(r),elevatedSecondary:$K(n,.96),elevatedSecondaryOpaque:nq(n),iconAccent:e.theme.accent,iconPrimary:e.theme.ink,iconSecondary:$K(e.ink,.65+e.contrast*.1),iconTertiary:$K(e.ink,.45+e.contrast*.1),simpleScrim:$K(rq,.08+e.contrast*.04),textAccent:e.theme.accent,textButtonPrimary:e.theme.surface,textButtonSecondary:e.theme.ink,textButtonTertiary:$K(e.ink,.45+e.contrast*.1),textForeground:e.theme.ink,textForegroundSecondary:$K(e.ink,.65+e.contrast*.1),textForegroundTertiary:$K(e.ink,.45+e.contrast*.1)}}

function d4i(e,t){let n=qK[t];return e.accent===n.accent&&e.contrast===n.contrast&&e.fonts.code===n.fonts.code&&e.fonts.codeFace==null&&e.fonts.ui===n.fonts.ui&&e.fonts.uiFace==null&&e.fonts.content==null&&e.fonts.contentFace==null&&e.ink===n.ink&&e.opaqueWindows===n.opaqueWindows&&e.semanticColors.diffAdded===n.semanticColors.diffAdded&&e.semanticColors.diffRemoved===n.semanticColors.diffRemoved&&e.semanticColors.skill===n.semanticColors.skill&&e.surface===n.surface}

function f4i(e){let t=tq(e.surface,e.ink,.06+e.contrast*.05),n=tq(e.accent,iq,.3+e.contrast*.15),r=tq(e.surface,rq,.38+e.contrast*.12),i=tq(e.surface,e.ink,.08+e.contrast*.08);return{accentBackground:eq(rq,e.accent,.2+e.contrast*.08),accentBackgroundActive:eq(rq,e.accent,.22+e.contrast*.12),accentBackgroundHover:eq(rq,e.accent,.21+e.contrast*.1),border:$K(e.ink,.06+e.contrast*.04),borderFocus:$K(n,.7+e.contrast*.1),borderHeavy:$K(e.ink,.12+e.contrast*.06),borderLight:$K(e.ink,.03+e.contrast*.02),buttonPrimaryBackground:nq(r),buttonPrimaryBackgroundActive:$K(e.ink,.07+e.contrast*.05),buttonPrimaryBackgroundHover:$K(e.ink,.04+e.contrast*.03),buttonPrimaryBackgroundInactive:$K(e.ink,.02+e.contrast*.02),buttonSecondaryBackground:$K(e.ink,.04+e.contrast*.02),buttonSecondaryBackgroundActive:$K(e.ink,.09+e.contrast*.05),buttonSecondaryBackgroundHover:$K(e.ink,.06+e.contrast*.03),buttonSecondaryBackgroundInactive:$K(e.ink,.02+e.contrast*.03),buttonTertiaryBackground:$K(e.ink,.02+e.contrast*.015),buttonTertiaryBackgroundActive:$K(e.ink,.07+e.contrast*.05),buttonTertiaryBackgroundHover:$K(e.ink,.05+e.contrast*.03),controlBackground:$K(t,.96),controlBackgroundOpaque:nq(t),elevatedPrimary:$K(i,.96),elevatedPrimaryOpaque:nq(i),elevatedSecondary:$K(e.ink,.02+e.contrast*.02),elevatedSecondaryOpaque:eq(e.surface,e.ink,.04+e.contrast*.05),iconAccent:nq(n),iconPrimary:$K(e.ink,.82+e.contrast*.14),iconSecondary:$K(e.ink,.65+e.contrast*.1),iconTertiary:$K(e.ink,.45+e.contrast*.1),simpleScrim:$K(e.ink,.08+e.contrast*.04),textAccent:nq(n),textButtonPrimary:nq(r),textButtonSecondary:eq(e.ink,e.surface,.7+e.contrast*.1),textButtonTertiary:$K(e.ink,.45+e.contrast*.1),textForeground:d4i(e.theme,`dark`)?`var(--gray-fixed-150)`:e.theme.ink,textForegroundSecondary:$K(e.ink,.65+e.contrast*.1),textForegroundTertiary:$K(e.ink,.42+e.contrast*.13)}}

function p4i(e,t){let n=T4i[t],r=n/100,i=e/100+(e-n)/60*E4i;return e<=n?i:r+(i-r)*D4i}

function m4i(e,t,n,r){let i=T4i[r],a=O4i[r]+(e.contrast-i)*k4i[r];return r===`light`?eq(t,n,a):eq(t,rq,a)}

function h4i(e){let t=e.variant===`light`?iq:e.ink;return eq(e.surface,t,A4i[e.variant]+e.contrast*j4i[e.variant])}

function g4i(e){let t=e.slice(1);return{blue:Number.parseInt(t.slice(4,6),16),green:Number.parseInt(t.slice(2,4),16),red:Number.parseInt(t.slice(0,2),16)}}

function $K(e,t){return`rgba(${e.red}, ${e.green}, ${e.blue}, ${v4i(t)})`}

function eq(e,t,n){return S4i(tq(e,t,n))}

function tq(e,t,n){let r=Math.min(1,Math.max(0,n));return{blue:_4i(e.blue,t.blue,r),green:_4i(e.green,t.green,r),red:_4i(e.red,t.red,r)}}

function _4i(e,t,n){return Math.round(e+(t-e)*n)}

function v4i(e){return Math.min(1,Math.max(0,e)).toFixed(3).replace(/0+$/,``).replace(/\.$/,``)}

function y4i(e){if(e.blue>e.red&&e.blue>e.green){let t=e.blue-Math.min(e.red,e.green),n=((e.red-e.green)/t+4)*60;if(t/e.blue>=.8&&n>=205&&n<=212||t/e.blue>=.6&&n>=218&&n<=233&&b4i(e)<=.21)return iq}return b4i(e)>w4i?rq:iq}

function b4i(e){return x4i(e.red)*.2126+x4i(e.green)*.7152+x4i(e.blue)*.0722}

function x4i(e){let t=e/255;return t<=.04045?t/12.92:((t+.055)/1.055)**2.4}

function S4i(e){return`#${C4i(e.red)}${C4i(e.green)}${C4i(e.blue)}`}

function nq(e){return`rgb(${e.red}, ${e.green}, ${e.blue})`}

function C4i(e){return e.toString(16).padStart(2,`0`)}

function M4i(){return(M4i=e((()=>{Y0i(),Z2i(),$2i(),r4i(),rq={blue:0,green:0,red:0},iq={blue:255,green:255,red:255},w4i=.179,T4i={dark:qK.dark.contrast,light:qK.light.contrast},E4i=.7,D4i=2,O4i={dark:.16,light:.04},k4i={dark:.0015,light:.0012},A4i={dark:.03,light:.18},j4i={dark:.03,light:.008}})))()}
