# Proclaim News Worker

نسخه آماده استقرار برای Cloudflare Workers + KV + RSS.

## قبل از Deploy

1. داخل `wrangler.jsonc` نام Worker را در صورت نیاز تغییر بده.
2. دو KV Namespace بساز:
   - `npx wrangler kv namespace create NEWS_KV`
   - `npx wrangler kv namespace create NEWS_KV --preview`
3. IDهای خروجی را جایگزین `REPLACE_WITH_PRODUCTION_KV_ID` و `REPLACE_WITH_PREVIEW_KV_ID` کن.
4. `npm install` را اجرا کن.
5. تست: `npx wrangler dev`
6. تست Cron محلی: `curl -X POST http://localhost:8787/__scheduled`
7. Deploy: `npx wrangler deploy`

## نکته مهم

- خبرها با SHA-256 از URL نرمال‌شده شناسه‌گذاری می‌شوند؛ بنابراین duplicate شدن خبر به خاطر race بین دو feed عملاً به overwrite همان رکورد تبدیل می‌شود.
- KV قفل قطعی و اتمیک نیست؛ lease فقط guard کمکی است. برای قفل توزیع‌شده قطعی باید Durable Object استفاده شود.
- `index.html` ارسالی شما در `public/index.html` نگه داشته شده و با API `/api/news` به اخبار واقعی متصل شده است.
- سیستم حساب کاربری فعلی `index.html` همچنان client-side/localStorage است و برای احراز هویت واقعی Production باید بعداً به backend امن منتقل شود؛ رمز عبور را برای سیستم حساس در localStorage نگه ندارید.
