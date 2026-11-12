# HYP Payments: סקיל ל-Claude Code לסליקה ב-HYP Pay

סקיל (Skill) ל-Claude Code שמחבר מערכת ל-HYP Pay (לשעבר יעד שריג) מקצה לקצה ובבטחה: דף תשלום חד פעמי
עם תשלומים וחשבונית, מנוי חודשי עם טוקן ובדיקת כרטיס J5, ביטול וזיכוי מתוך המערכת, וחשבוניות HYP Invoice.

הסקיל נבנה מחיבורים אמיתיים ל-HYP שרצו בייצור ב-2026, והוא מתעד גם את המקומות שבהם HYP מתנהגים בפועל
אחרת ממה שכתוב בתיעוד.

## מה יש בפנים

| חלק | מה זה נותן |
|---|---|
| `SKILL.md` | ההוראות ל-Claude: ראיון פתיחה של 12 שאלות, המסלול המהיר, עקרונות הבטיחות, והמלכודות שנלמדו |
| `references/interview.md` | השאלות, ברירות המחדל, ומה כל תשובה משנה בבנייה |
| `references/terminal-setup.md` | הגדרות בפורטל של HYP, ההרשאות שצריך לבקש, הודעה מוכנה לתמיכה, הגדרת סודות |
| `references/protocol.md` | כל קריאה ל-HYP עם הפרמטרים, התשובות וקודי הסטטוס, מסומנת LIVE, DOC או CONTRADICTS-DOC |
| `references/architecture.md` | הזרימות, מודל הנתונים, ותביעות (claims) ונעילות שמונעות חיוב כפול |
| `references/subscriptions.md` | מנוי חודשי: הריצה היומית, ניסיונות חוזרים, ימי חסד, או הוראת קבע של HYP |
| `references/testing-and-go-live.md` | סולם הבדיקות: בדיקות אוטומטיות, מסכים, פריסה, כסף אמיתי, בדיקת דליפה |
| `templates/` | קוד מוכן ל-Base44: ישויות, פונקציות Deno, עמוד חזרה, פאנל אדמין, Workflow יומי, ו-16 בדיקות מול HYP מדומה |

## למי זה מתאים

מפתחים בישראל שגובים כסף דרך HYP Pay. התבניות כתובות ל-Base44 (פרונט React ופונקציות Deno), אבל
הפרוטוקול וכללי הבטיחות מתאימים לכל סטאק: `templates/base44/shared/hyp.ts` לא תלוי ב-Base44, ומה
שמחליפים הוא רק שכבת הרשומות.

## התקנה

התקנה לכל הפרויקטים (סקיל אישי):

```bash
git clone https://github.com/roishmuel14/hyp-payments-skill.git ~/.claude/skills/hyp-payments
```

או רק לפרויקט אחד (מתוך תיקיית הפרויקט):

```bash
git clone https://github.com/roishmuel14/hyp-payments-skill.git .claude/skills/hyp-payments
```

אחרי ההתקנה פותחים שיחה חדשה ב-Claude Code. עדכון לגרסה חדשה:

```bash
git -C ~/.claude/skills/hyp-payments pull
```

## שימוש

Claude טוען את הסקיל לבד כשמדברים על HYP, סליקה, דף תשלום, מנוי, טוקן או זיכוי. אפשר גם לקרוא לו
ישירות עם `/hyp-payments`. דוגמאות:

- "תחבר את האפליקציה שלי ל-HYP: דף תשלום חד פעמי עם עד 3 תשלומים וחשבונית"
- "אני רוצה מנוי חודשי עם חודש ניסיון חינם, והכרטיס נבדק בהרשמה"
- "מה צריך לבקש מ-HYP לפני שמתחילים?"
- "VERIFY נכשל על תשלום שהלקוח אומר שעבר. מה קורה?"
- "תוסיף לאדמין כפתור ביטול וזיכוי"

הסקיל מתחיל בראיון קצר (חד פעמי או מנוי, ניסיון חינם, תשלומים, חשבוניות, תעודת זהות), ורק אחריו
כותבים קוד.

## הבדיקות של התבניות

צריך Node ו-Deno. מתוך התיקייה `templates/`:

```bash
node scripts/sync-shared.mjs && deno test --no-config --node-modules-dir=none --import-map=tests/import_map.json --allow-env --allow-read=. tests/
```

התוצאה הצפויה: 16 בדיקות עוברות (59 צעדים). אחר כך `bash tests/break-checks.sh` שובר כל פעם כלל כסף
אחד ומוודא שהבדיקות תופסות אותו (צריך גם `python3`).

## מודל הבטיחות

- **כסף אמיתי זז רק בידיים של אדם.** חיוב, ביטול, זיכוי, בדיקת כרטיס בדף החי או הרצת החיוב החודשי מול
  מסוף אמיתי: אדם לוחץ במסך, ו-Claude רק קורא את התוצאה.
- **סודות לא עוברים בצ'אט.** `HYP_MASOF`, `HYP_PASSP` ו-`HYP_KEY` נכנסים לסודות של הפלטפורמה, שורה אחת
  לכל סוד, למשל `npx base44 secrets set HYP_KEY='...' --app-id <your-app-id>`. מחליפים רק את מה שבין
  הגרשיים, ולא מדביקים את הערך בשיחה.
- **הטוקן ותעודת הזהות נשארים בשרת.** לדפדפן יוצאות רק 4 ספרות ותוקף. כתובות שנשלחו ל-HYP (עם `PassP`
  ו-`KEY`) לא נכתבות ללוג.
- **"לא ידוע" זה לא "נכשל".** כשאין תשובה מ-HYP, ייתכן שהכרטיס חויב: המערכת לא מנסה שוב לבד, ואדם
  בודק בפורטל.
- **החיוב החודשי כבוי עד שמדליקים אותו.** הסוד `BILLING_MODE` לא מוגדר = כבוי (הריצה היומית רק
  מתכננת); `test` מחייב רק לקוחות בדיקה 1 ₪; `live` מחייב את כולם, רק ביום ההשקה ואחרי מחיקת נתוני
  הבדיקה.

## הבהרה

הפרויקט הזה לא קשור ל-HYP (Hyp Pay, יעד שריג), לא מטעמם ולא באישורם. השמות והסימנים המסחריים שייכים
לבעליהם. המידע נכון למה שנראה ב-2026, ו-HYP יכולים לשנות התנהגות בכל רגע: בדקו כל פרמטר מול
[התיעוד הרשמי של HYP](https://developers.hyp.co.il/pay) ועל המסוף שלכם לפני שגובים כסף אמיתי. אין כאן
ייעוץ משפטי, חשבונאי או מיסויי (מע"מ, חשבוניות), ואין אחריות: ראו את הרישיון.

## רישיון

MIT. ראו [LICENSE](LICENSE).

---

## English

**HYP Payments** is a Claude Code skill for taking payments in Israel with HYP Pay (formerly Yaad
Sarig): one-time payment pages with installments and invoices, monthly subscriptions with
merchant-managed tokens and a J5 card check, cancels and refunds from the admin, and HYP Invoice. It was
distilled from production HYP integrations in 2026 and records where HYP's real behaviour differs from
its docs.

- **Who it is for:** developers who take payments through HYP Pay. The templates target Base44 (a
  React frontend and Deno backend functions), but the protocol module
  (`templates/base44/shared/hyp.ts`) and the safety rules work on any stack.
- **Install:** `git clone https://github.com/roishmuel14/hyp-payments-skill.git ~/.claude/skills/hyp-payments`
  (or into a project's `.claude/skills/hyp-payments`), then start a new Claude Code session.
- **Use:** mention HYP, a payment page, a subscription or a refund, or invoke `/hyp-payments`. For
  example: "Connect my app to HYP Pay with a one-time payment page and up to 3 installments", "Add a
  monthly subscription with a 30-day free trial", "VERIFY fails on a payment the customer says went
  through". The skill starts with a short interview before any code is written.
- **Tests:** from `templates/`, run the `deno test` command above: 16 tests (59 steps) against a fake
  HYP and a fake Base44 SDK, plus `tests/break-checks.sh`.
- **Safety model:** only a human presses real-money actions; Claude only reads the results. Secrets
  never go through the chat: set them with `npx base44 secrets set NAME='...' --app-id <your-app-id>`
  (or your platform's secret store). Card tokens and ID numbers stay on the server. A charge without
  an answer is "unknown" and is never retried automatically. Automatic monthly billing is off until a
  `BILLING_MODE` secret turns it on (`test`: test customers at 1 ILS; `live`: everyone).
- **Disclaimer:** not affiliated with, endorsed by or connected to HYP. Verify everything against
  [HYP's official documentation](https://developers.hyp.co.il/pay) and on your own terminal before
  taking real money. Not legal, tax or accounting advice. No warranty.
- **License:** MIT.
