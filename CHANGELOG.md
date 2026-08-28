# 📦 Changelog

All notable changes to this project will be documented in this file.

---

## [2.1.0] - 2025-11-13

### Added
- Telebirr: Return `bankName` in receipt payloads.

### Changed
- Bump API version to `2.1.0` in package.json, root endpoint, README, Postman collection.

## [1.1.0] - 2025-05-18

> This release introduces the first major backend expansion: transitioning from a fully in-memory system to a database-powered API with authentication, stats, and admin tools.

### 🚀 Added

- 🔐 **API Key Authentication**
  - All verification endpoints (except `/` and `/health`) now require a valid API key.
  - Keys are stored in a Prisma-managed MySQL database.
  - Requests without valid keys are denied with a 401/403 error.

- ⚙️ **Admin Routes**
  - `POST /admin/api-keys`: Generate a new API key.
  - `GET /admin/api-keys`: View all active/used keys (securely abbreviated).
  - `GET /admin/stats`: View endpoint usage, response times, and request logs.

- 📊 **Usage Statistics Logging**
  - Each request is logged to a `UsageLog` table with:
    - API key ID
    - Endpoint
    - Method
    - Response time
    - Status code
    - IP address
  - Statistics are cached in-memory and pulled from the DB for admin views.

- 🛠 **Prisma + MySQL Integration**
  - Introduced full Prisma schema and MySQL connection to persist:
    - API keys
    - Usage logs

- 📁 **API Versioning Support**
  - Branch `api-keys-introduced` now tracks this new release.
  - Tagged as version `v1.1.0` in `package.json`.

### 🧹 Changed

- 🧠 Moved all key storage and logic from in-memory Maps to persistent DB.
- 🔄 `requestLogger` middleware now uses `res.on('finish')` for accurate response timing and DB writes.

### 🛡️ Security

- Admin routes are protected using `x-admin-key` headers.
- API keys are validated per request, and rate-limiting can be layered on in the future.

---

## [1.0.0] - 2025-05-12

> Initial release of the Payment Verifier API.

### ✨ Features

- ✅ **CBE Verification** via reference and suffix using Puppeteer and PDF parsing.
- ✅ **Telebirr Verification** using raw reference scraping.
- ✅ **Image-Based Verification** powered by **Mistral AI**, detecting CBE or Telebirr receipts.
- 🧪 Express API with simple `POST` endpoints:
  - `/verify-cbe`
  - `/verify-telebirr`
  - `/verify-image`
- 🔍 In-memory statistics and logging.

---
