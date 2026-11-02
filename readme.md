# Coasther API Documentation

This project is licensed under GPL v3.

For commercial usage without open-source obligation,
please contact the author.

Base URL (local):

```
http://localhost:5000
```

Semua response menggunakan format JSON standar:

```json
{
  "success": true,
  "message": "OK",
  "data": {}
}
```

---

## Demo Akun

email : gn.nanda0@gmail.com
pw : Admin#1234

## Authentication

### Register

**POST** `/api/auth/register`

Body:

```json
{
  "name": "Andi",
  "email": "andi@test.com",
  "password": "password123",
  "phone": "08123456789"
}
```

---

### Login

**POST** `/api/auth/login`

Body:

```json
{
  "email": "andi@test.com",
  "password": "password123"
}
```

Response:

```json
{
  "data": {
    "token": "JWT_TOKEN"
  }
}
```

---

### Get Current User

**GET** `/api/auth/me`

Header:

```
Authorization: Bearer <JWT_TOKEN>
```

---

## Rooms (Public)

### List Rooms

**GET** `/api/rooms`

Query params (optional):

- `search`
- `is_available`
- `page`
- `limit`

---

### Room Detail

**GET** `/api/rooms/:id`

---

## Announcements (Public)

### List Announcements

**GET** `/api/announcements`

Query:

- `page`
- `limit`

---

## Tenant Dashboard

> Semua endpoint di bawah **wajib login**

Header:

```
Authorization: Bearer <JWT_TOKEN>
```

---

### Dashboard Summary (1 request)

**GET** `/api/dashboard`

Response berisi:

- Room + lease
- Usage bulan ini
- Invoice bulan ini
- Announcements terbaru

---

### My Room

**GET** `/api/my-room`

Mengambil:

- Lease aktif
- Room
- Facilities
- Meters (air & listrik)

---

## Usage Monitoring

### Monthly Usage

**GET** `/api/my-usage`

Query (optional):

- `month=YYYY-MM`

---

### Meter Reading History (Chart)

**GET** `/api/my-meter-readings`

Query:

- `type=water|electricity`
- `from` (ISO datetime, optional)
- `to` (ISO datetime, optional)
- `limit`

---

## Invoices

### Current Invoice

**GET** `/api/my-invoices/current`

---

### Invoice History

**GET** `/api/my-invoices`

Query:

- `status`
- `page`
- `limit`

---

## Payments (Midtrans)

### Create Midtrans Transaction

**POST** `/api/payments/midtrans`

Body:

```json
{
  "invoice_id": 1
}
```

Response:

```json
{
  "snap_token": "xxxxx",
  "redirect_url": "https://app.midtrans.com/..."
}
```

---

### Midtrans Webhook

**POST** `/api/payments/midtrans/webhook`

> Endpoint ini dipanggil langsung oleh Midtrans (public)

---

## 🛠 Complaints (Tenant)

### Create Complaint

**POST** `/api/complaints`

Body:

```json
{
  "title": "Lampu mati",
  "description": "Lampu kamar sering mati"
}
```

---

### List My Complaints

**GET** `/api/complaints`

Query:

- `status`
- `page`
- `limit`

---

### Complaint Detail

**GET** `/api/complaints/:id`

---

### Update / Close Complaint

**PATCH** `/api/complaints/:id`

Body (close):

```json
{ "status": "closed" }
```

---

## AI Chat (Admin Only)

### Chat with AI

**POST** `/api/ai/admin-chat`

Body:

```json
{
  "question": "Berapa tagihan yang belum lunas bulan ini?",
  "conversationHistory": [
    { "role": "user", "content": "Hai" },
    {
      "role": "model",
      "content": "Halo! Ada yang bisa saya bantu terkait data kost hari ini?"
    }
  ]
}
```

---

## Announcements

### List Announcements (Public)

**GET** `/api/announcements`

### Create Announcement (Admin)

**POST** `/api/announcements`

### Update Announcement (Admin)

**PATCH** `/api/announcements/:id`

### Delete Announcement (Admin)

**DELETE** `/api/announcements/:id`

---

## 🔔 Push Notifications

Sistem menggunakan Firebase Cloud Messaging (FCM) untuk memberikan notifikasi real-time kepada tenant untuk kejadian berikut:

- **Tagihan Baru**: Saat invoice bulanan digenerate.
- **Tagihan Terlambat**: Saat status invoice berubah menjadi `overdue`.
- **Pembayaran Berhasil**: Saat pembayaran via Midtrans telah terkonfirmasi (`paid`).
- **Update Keluhan**: Saat admin memperbarui status keluhan (complaint).
- **Pengumuman**: Broadcast ke seluruh tenant saat admin membuat pengumuman baru.

---

## Reviews

### Submit Review (Tenant)

**POST** `/api/reviews`

Body:

```json
{
  "rating": 5,
  "comment": "Kamar bersih dan nyaman"
}
```

---

### My Reviews

**GET** `/api/reviews/my`

---

### Room Reviews (Public)

**GET** `/api/reviews/rooms/:id`

---

## IoT Integration

### Send Meter Reading

**POST** `/api/iot/meter-reading`

Header:

```
x-device-uid: DEVICE_UID
```

Body:

```json
{
  "reading_value": 123.456
}
```

Optional:

```json
{
  "reading_value": 123.456,
  "recorded_at": "2026-01-20T10:00:00Z"
}
```

Rules:

- Reading **harus kumulatif**
- Tidak boleh lebih kecil dari reading sebelumnya

---

## Billing Automation (Internal)

> Tidak melalui HTTP API

### Monthly Usage Job

```
runUsageMonthly('YYYY-MM')
```

### Monthly Invoice Job

```
generateInvoicesForMonth('YYYY-MM')
```

Dijalankan otomatis via **node-cron** di backend.

---

## Authorization Rules (Ringkas)

| Role            | Akses                                                         |
| --------------- | ------------------------------------------------------------- |
| Public          | Rooms, Announcements, Reviews                                 |
| Tenant          | Dashboard, Room, Usage, Invoice, Payment, Complaints, Reviews |
| Admin / Manager | Sama dengan tenant + (admin feature nanti)                    |
| IoT Device      | Meter reading saja                                            |

---

## Testing Flow (Disarankan)

1. Register & Login
2. Assign lease + room (seed data)
3. Jalankan job monthly
4. Cek:
   - `/api/dashboard`
   - `/api/my-usage`
   - `/api/my-invoices/current`

5. Payment via Midtrans
6. Complaints & Reviews

---

## Notes

- Semua API response konsisten (`success`, `message`, `data`)
- Billing berbasis **meter kumulatif**
- Sistem dirancang untuk **single kost, multi room**
- Aman untuk prototipe dan scalable ke production
