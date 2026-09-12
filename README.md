# 🤖 Zalo Barobot - Hệ Thống Tự Động Gửi Lịch Trực Qua Zalo

Hệ thống tự động hóa đọc lịch trực cổng, phân công nhiệm vụ và lịch tranh thủ từ Google Sheets của các tiểu đội quân sự, định dạng thành tin nhắn trực quan và gửi đến đúng các nhóm chat Zalo theo lịch trình hẹn giờ hoặc theo yêu cầu.

---

## 📑 Mục lục
1. [Tính năng chính](#1-tính-năng-chính)
2. [Kiến trúc hệ thống & Cấu trúc thư mục](#2-kiến-trúc-hệ-thống--cấu-trúc-thư-mục)
3. [Cài đặt & Chạy môi trường Local](#3-cài-đặt--chạy-môi-trường-local)
4. [Hướng dẫn thiết lập Google Sheets API](#4-hướng-dẫn-thiết-lập-google-sheets-api)
5. [Hướng dẫn lấy Chat ID cá nhân và nhóm Zalo](#5-hướng-dẫn-lấy-chat-id-cá-nhân-và-nhóm-zalo)
6. [Hướng dẫn cấu hình Webhook Zalo Bot](#6-hướng-dẫn-cấu-hình-webhook-zalo-bot)
7. [Hướng dẫn thêm Tiểu đội / Lịch trực mới (Mở rộng bằng Cấu hình)](#7-hướng-dẫn-thêm-tiểu-đội--lịch-trực-mới-mở-rộng-bằng-cấu-hình)
8. [Hướng dẫn triển khai lên Railway (Production)](#8-hướng-dẫn-triển-khai-lên-railway-production)
9. [Ghi chú kỹ thuật về tính năng xóa tin nhắn cũ (F4)](#9-ghi-chú-kỹ-thuật-về-tính-năng-xóa-tin-nhắn-cũ-f4)

---

## 1. Tính năng chính

- **F1 - Tự động gửi lịch hàng ngày**: Lên lịch tự động theo giờ cấu hình cho từng tiểu đội:
  - **Tiểu đội 2 (chính)**: Tự động gửi lịch của **ngày mai** vào lúc **21:00 tối hôm trước**.
  - **Tiểu đội culi (ca đêm)**: Tự động gửi lịch ca đêm chuẩn bị tới vào lúc **05:30 sáng**.
- **F2 - Gửi lại theo yêu cầu qua Web**: Admin bấm nút gửi riêng từng lịch từ Web Dashboard có xác thực.
- **F3 - Gửi lại qua lệnh chat Zalo (`/gui`)**: Thành viên trong nhóm chat chỉ cần gõ `/gui`, bot sẽ gửi ngay lịch liên quan đến đúng nhóm đó.
- **F4 - Xóa tin nhắn cũ (Best-effort)**: Tự động cố gắng xóa tin nhắn lịch cũ trước khi gửi tin mới để nhóm không bị trôi/rác tin nhắn.
- **F5 - Lịch tranh thủ**: Gửi danh sách người đi tranh thủ và người mất lượt của tuần tương ứng theo yêu cầu.
- **F6 - Nhắc nhở Admin**: 
  - Nhắc trước 1 tiếng: Báo Admin kiểm tra Google Sheet trước giờ bot tự gửi (ví dụ lúc 20:00 tối).
  - Cảnh báo quá hạn: Nếu quá giờ mà lịch chưa được gửi thành công, bot sẽ gửi tin nhắn báo động cho Admin (ví dụ lúc 21:10).
- **F7 - Đa dạng định dạng người nhận**: Trích xuất riêng các ca đi tuần từ bảng lịch chung để gửi tóm tắt cho Trung đội trưởng.
- **F8 - Mở rộng linh hoạt**: Thêm tiểu đội, bảng tính hoặc người nhận mới hoàn toàn qua file `config/schedules.yaml`, không sửa code lõi.
- **F9 - Cấu hình Runtime trên Web không cần redeploy**: Đổi tên tab Google Sheet (khi chuyển doanh trại), bật/tắt gửi lịch ngày mai, đổi giờ gửi trực tiếp trên giao diện web.
- **F10 - Xem trước tin nhắn (Preview)**: Xem trước văn bản sẽ gửi, chuyển đổi nhanh giữa *Hôm nay* và *Ngày mai*, sao chép nội dung hoặc bấm gửi ngay.
- **F11 - Nhật ký gửi tin**: Lưu lại 50 lần gửi gần nhất kèm trạng thái thành công/thất bại và chi tiết lỗi.
- **F12 - Quản lý đối tượng nhận lịch (Recipients) qua Web UI**: Quản lý CRUD danh sách người nhận (Mã, Tên hiển thị, Chat ID) lưu trong SQLite. Gán multi-select đối tượng nhận cho từng lịch trực tiếp trên Web UI không cần sửa code hay redeploy. Tự động de-assign an toàn khi xóa người nhận.
- **F13 - Thống kê tần suất tranh thủ & Soạn tin nhắn gửi nhóm**: Tự động tính toán 4 chỉ số (Số lần đã về, Số lần mất lượt, Lần gần nhất được về, Đang cách bao nhiêu lượt chưa về), sắp xếp ưu tiên người chờ lâu nhất. Soạn tin nhắn trực quan chuẩn mẫu kèm emoji và gửi tới nhóm qua `send_schedule()`.

---

## 2. Kiến trúc hệ thống & Cấu trúc thư mục

Hệ thống được thiết kế phân tầng nghiêm ngặt (theo Mục 4 tài liệu SPEC):

```
                   ┌──────────────────┐
                   │   Google Sheet   │ (Chỉ đọc qua Service Account)
                   └────────┬─────────┘
                            │ Range động
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  SHEET READER LAYER (src/sheets/)                            │
│  - gateDutyTwoRowParser: Nhận diện mốc 'Ngày', forward-fill  │
│  - gateDutySingleRowParser: Parser ca đêm, chặn bảng phụ     │
│  - leaveRosterParser: Parser lịch tranh thủ                  │
│  - dateUtils: Xử lý logic ca đêm & gửi trước ngày mai        │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  FORMATTER LAYER (src/formatters/)                           │
│  - gateDutyFormatter: Mẫu tin nhắn trực cổng ngày / đêm      │
│  - patrolOnlyFormatter: Mẫu tin nhắn chỉ gồm ca đi tuần      │
│  - leaveRosterFormatter: Mẫu tin nhắn lịch tranh thủ         │
│  - Formatter Registry: Đăng ký theo 'type' tự do             │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  CORE ENGINE (src/core/sendSchedule.ts)                      │
│  - Điểm tập trung gửi duy nhất: Đọc cấu hình -> Ghép tin     │
│    -> Xóa tin cũ -> Gửi tin mới -> Lưu SQLite & History      │
└───────────────────────────┬──────────────────────────────────┘
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  ZALO CLIENT (src/core/zaloClient.ts)                        │
│  - Gọi trực tiếp REST API: sendMessage, deleteMessage,       │
│    setWebhook, getMe                                         │
└──────────────────────────────────────────────────────────────┘
  ▲                         ▲                         ▲
  │                         │                         │
┌─┴───────────────────────┐ ┌┴──────────────────────┐ ┌┴───────────────┐
│ Web UI & API (F2,F5,F9) │ │ Webhook Zalo (/gui F3)│ │ Scheduler (F1,F6)│
│ (src/channels/web.ts)   │ │(src/channels/webhook) │ │(src/channels/..)│
└─────────────────────────┘ └───────────────────────┘ └─────────────────┘
```

### Cấu trúc cây thư mục:
```text
zalo_barobot/
├── config/
│   └── schedules.yaml       # File cấu hình khai báo squads, schedules, recipients, reminders
├── public/
│   └── index.html           # Web UI Dashboard (HTML + Tailwind CSS + Alpine.js)
├── scripts/
│   ├── setWebhook.ts        # Script đăng ký Webhook với Zalo
│   └── deleteWebhook.ts     # Script hủy Webhook để chuyển sang Polling
├── src/
│   ├── channels/            # Tầng giao tiếp: Web UI, Webhook, Scheduler, Auth
│   ├── config/              # Nạp và quản lý cấu hình schedules.yaml
│   ├── core/                # sendSchedule central engine & ZaloClient
│   ├── formatters/          # Định dạng tin nhắn tiếng Việt
│   ├── sheets/              # Đọc Google Sheets và bộ phân tích bảng
│   ├── store/               # Lưu trữ SQLite (better-sqlite3)
│   ├── types/               # TypeScript interfaces
│   └── index.ts             # Điểm khởi động chính của ứng dụng
├── tests/                   # 36 bài kiểm thử tự động (Vitest)
├── .env.example             # Mẫu biến môi trường
├── Dockerfile               # Dockerfile triển khai Node.js process duy nhất
└── getChatID.js             # Tiện ích lấy Chat ID người dùng/nhóm qua Polling
```

---

## 3. Cài đặt & Chạy môi trường Local

### 3.1. Yêu cầu môi trường
- **Node.js**: Phiên bản 20.x LTS trở lên (khuyên dùng Node 20 hoặc 24).
- **npm**: Phiên bản 9.x trở lên.

### 3.2. Các bước cài đặt
```bash
# 1. Cài đặt các dependencies
npm install

# 2. Tạo file cấu hình môi trường từ mẫu
cp .env.example .env

# 3. Chạy toàn bộ bài kiểm thử tự động
npm test

# 4. Biên dịch TypeScript
npm run build

# 5. Khởi chạy ở chế độ phát triển (Development)
npm run dev
```

### 3.3. Đăng nhập Web Dashboard
- Mở trình duyệt truy cập: `http://localhost:3000`
- **Tài khoản mặc định**:
  - Tên đăng nhập: `admin`
  - Mật khẩu: `change_this_password` (hoặc cấu hình tại `ADMIN_PASSWORD` trong `.env`).

---

## 4. Hướng dẫn thiết lập Google Sheets API

Hệ thống cần quyền đọc bảng tính Google Sheets thông qua **Google Service Account** (hoàn toàn miễn phí):

### Bước 1: Tạo tài khoản Service Account
1. Truy cập [Google Cloud Console](https://console.cloud.google.com).
2. Tạo một Project mới (ví dụ: `Zalo Schedule Bot`).
3. Vào ô tìm kiếm trên cùng, gõ **Google Sheets API** $\rightarrow$ Bấm nút **Enable**.
4. Vào menu **APIs & Services** $\rightarrow$ **Credentials** $\rightarrow$ Bấm **+ Create Credentials** $\rightarrow$ Chọn **Service Account**.
5. Đặt tên tài khoản (ví dụ: `zalo-bot`) $\rightarrow$ Bấm **Create and Continue** $\rightarrow$ Bấm **Done**.

### Bước 2: Tải file khóa JSON
1. Bấm vào email của Service Account vừa tạo (đuôi `@...iam.gserviceaccount.com`).
2. Vào tab **Keys** $\rightarrow$ Bấm **Add Key** $\rightarrow$ Chọn **Create new key**.
3. Chọn loại **JSON** $\rightarrow$ Bấm **Create**. Trình duyệt sẽ tải về một file `.json`.
4. Đổi tên file vừa tải về thành `service-account.json` và lưu vào thư mục gốc của dự án:
   `/workspaces/zalo_barobot/service-account.json`

### Bước 3: Lấy Google Sheet ID và cấp quyền xem
1. Mở file Google Sheet lịch trực trên trình duyệt, URL có dạng:
   ```text
   https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0
   ```
   Dãy ký tự giữa `/d/` và `/edit` chính là `GOOGLE_SHEET_ID`:
   `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms`
2. Mở Google Sheet $\rightarrow$ Bấm nút **Chia sẻ (Share)** ở góc trên bên phải.
3. Dán email của Service Account (tìm thấy ở dòng `"client_email"` trong file `service-account.json`) vào và cấp quyền **Người xem (Viewer)**.
4. Cập nhật vào file `.env`:
   ```env
   GOOGLE_SHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

---

## 5. Hướng dẫn lấy Chat ID cá nhân và nhóm Zalo

File [`getChatID.js`](file:///workspaces/zalo_barobot/getChatID.js) sử dụng cơ chế Polling để in ra ID của bất kỳ người dùng hay nhóm chat nào gửi tin nhắn tới bot.

1. Đảm bảo bot chưa bật Webhook (nếu đã bật, chạy lệnh `npm run delete-webhook` trước).
2. Chạy script:
   ```bash
   node getChatID.js
   ```
3. **Lấy Chat ID cá nhân của Admin**:
   - Mở Zalo, nhắn bất kỳ tin nhắn nào vào khung chat riêng 1-1 với Bot.
   - Terminal sẽ in ra Chat ID cá nhân của bạn.
4. **Lấy Chat ID của nhóm chat**:
   - Thêm Bot vào nhóm Zalo nhận lịch.
   - Gửi một tin nhắn bất kỳ vào nhóm.
   - Terminal sẽ in ra Chat ID của nhóm đó.
5. Sao chép các Chat ID trên vào file [`.env`](file:///workspaces/zalo_barobot/.env):
   ```env
   ADMIN_CHAT_ID=chat_id_cua_admin
   SQUAD_MAIN_CHAT_ID=chat_id_nhom_tieu_doi_2
   SQUAD_CULI_CHAT_ID=chat_id_nhom_tieu_doi_culi
   PLATOON_LEADER_CHAT_ID=chat_id_trung_doi_truong
   ```
6. Bấm `Ctrl + C` trên terminal để dừng script `getChatID.js`.

---

## 6. Hướng dẫn cấu hình Webhook Zalo Bot

Webhook giúp Bot nhận tin nhắn từ Zalo tức thì (dùng cho lệnh `/gui` - F3):

### 6.1. Khi test Local
- **Nếu dùng GitHub Codespaces**: 
  1. Chạy `npm run dev`.
  2. Bấm vào tab **Ports** $\rightarrow$ Chuột phải vào cổng `3000` $\rightarrow$ Chuyển **Port Visibility** thành **Public**.
  3. Copy địa chỉ HTTPS được forward (ví dụ: `https://xxxx-3000.app.github.dev`).
- **Nếu dùng máy tính cá nhân**:
  1. Mở terminal mới chạy: `npx cloudflared tunnel --url http://localhost:3000`
  2. Copy URL HTTPS sinh ra (ví dụ: `https://xxxx.trycloudflare.com`).

### 6.2. Đăng ký Webhook URL với Zalo
Chạy lệnh đăng ký:
```bash
npm run set-webhook https://<url-cua-ban>/webhook/zalo
```
*(Script sẽ tự động đọc `ZALO_BOT_TOKEN` và `ZALO_WEBHOOK_SECRET` trong `.env` để chứng thực).*

### 6.3. Hủy Webhook (khi cần quay lại dùng `getChatID.js`)
```bash
npm run delete-webhook
```

---

## 7. Hướng dẫn thêm Tiểu đội / Lịch trực mới (Mở rộng bằng Cấu hình)

Hệ thống tuân thủ **Quy tắc #11 & Tính năng F8**: Không dùng enum fix cứng, mọi mở rộng đều thực hiện thông qua file [`config/schedules.yaml`](file:///workspaces/zalo_barobot/config/schedules.yaml) mà không cần viết lại mã nguồn.

### Ví dụ cụ thể: Thêm "Tiểu đội 3"
Giả sử bạn cần thêm Tiểu đội 3 có lịch trực cổng ở tab `"Lịch trực Tiểu đội 3"`, tự động gửi lúc `06:00` sáng cho nhóm Zalo mới:

#### Bước 1: Khai báo Chat ID vào file `.env`
```env
SQUAD_3_CHAT_ID=9876543210123456
```

#### Bước 2: Khai báo trong `config/schedules.yaml`
Mở file `config/schedules.yaml` và thêm các mục sau:

```yaml
squads:
  # ... các squad cũ giữ nguyên ...
  squad_3:
    display_name: "Tiểu đội 3"
    sheet_tab_gate_duty: "Lịch trực Tiểu đội 3"
    header_style: two_row_merged   # hoặc single_row
    overnight: false

recipients:
  # ... các recipient cũ giữ nguyên ...
  squad_3_group: "$SQUAD_3_CHAT_ID"

schedules:
  # ... các schedule cũ giữ nguyên ...
  - key: squad_3_duty
    label: "Lịch trực cổng Tiểu đội 3"
    squad: squad_3
    type: gate_duty
    recipients:
      - squad_3_group
    auto_send_time: "06:00"
    enabled: true

reminders:
  - schedule_key: squad_3_duty
    remind_before_send_minutes: 60
    remind_if_not_sent_by: "06:10"
```

Sau khi lưu file, server sẽ tự động nhận diện lịch mới trên Web UI Dashboard và lên lịch tự động cho Tiểu đội 3!

---

## 8. Hướng dẫn triển khai lên Railway (Production)

Railway là nền tảng máy chủ phù hợp nhất nhờ tính năng Volume bền vững và không bị ngủ (auto-sleep) như Render free tier.

### Bước 1: Đẩy mã nguồn lên GitHub
```bash
git push origin main
```

### Bước 2: Tạo dự án trên Railway
1. Đăng nhập [railway.app](https://railway.app) $\rightarrow$ Bấm **New Project** $\rightarrow$ **Deploy from GitHub repo**.
2. Chọn repository `zalo_barobot`.

### Bước 3: Gắn Volume lưu trữ SQLite (Bắt buộc)
1. Trong màn hình Service trên Railway, bấm vào tab **Settings** $\rightarrow$ Mục **Volumes**.
2. Bấm **Add Volume**:
   - **Mount Path**: `/data`
3. Điều này đảm bảo file cơ sở dữ liệu SQLite (`/data/app.db`) không bị xóa mỗi khi bạn redeploy mã nguồn.

### Bước 4: Khai báo biến môi trường trên Railway
Chuyển sang tab **Variables** trên Railway và khai báo các biến:
```env
PORT=3000
DATABASE_PATH=/data/app.db
CONFIG_PATH=./config/schedules.yaml
ADMIN_USERNAME=admin
ADMIN_PASSWORD=mat_khau_quan_tri_cua_ban
ZALO_BOT_TOKEN=token_bot_zapps_me
ZALO_WEBHOOK_SECRET=chuoi_secret_webhook_cua_ban
GOOGLE_SHEET_ID=id_bảng_tính_google_sheet
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":...} # Dán toàn bộ nội dung file JSON vào đây
ADMIN_CHAT_ID=...
SQUAD_MAIN_CHAT_ID=...
SQUAD_CULI_CHAT_ID=...
PLATOON_LEADER_CHAT_ID=...
INTERNAL_API_KEY=khoa_bi_mat_cho_railway_cron
```

### Bước 5: Tạo Railway Cron Job (Bảo vệ kép - Mục 6.3)
Để đảm bảo hệ thống không bao giờ bị miss lịch kể cả khi container khởi động lại:
1. Tạo một Service mới trong cùng Project dạng **Cron Job** trên Railway.
2. Cấu hình lịch chạy: `*/5 * * * *` (mỗi 5 phút một lần).
3. Lệnh thực thi:
   ```bash
   curl -s -X POST https://${{RAILWAY_PUBLIC_DOMAIN}}/internal/run-due-jobs -H "x-internal-key: khoa_bi_mat_cho_railway_cron"
   ```

### Bước 6: Đăng ký Webhook chính thức
Chạy lệnh trỏ Webhook về tên miền Railway chính thức:
```bash
npm run set-webhook https://<ten-mien-cua-ban>.up.railway.app/webhook/zalo
```

---

## 9. Ghi chú kỹ thuật về tính năng xóa tin nhắn cũ (F4)

- **Cơ chế hoạt động**: Hàm `send_schedule` luôn thực hiện theo cơ chế **Best-effort**:
  1. Kiểm tra trong bảng `last_message` xem nhóm này trước đó đã nhận tin nhắn nào chưa.
  2. Nếu có `message_id` cũ, gọi API `deleteMessage` của Zalo.
  3. Nếu API thành công $\rightarrow$ tin nhắn cũ biến mất.
  4. Nếu API Zalo báo lỗi (do Zalo Bot Platform chưa mở quyền xóa tin nhóm hoặc tin nhắn đã gửi quá lâu) $\rightarrow$ Hệ thống ghi nhận warning log và **vẫn tiếp tục gửi tin nhắn mới bình thường**, không làm gián đoạn luồng gửi lịch.
- Sau khi gửi tin nhắn mới thành công, `message_id` mới luôn được cập nhật vào SQLite để phục vụ lần gửi kế tiếp.

---

## 10. Giấy phép & Tác giả
Dự án được phát triển phục vụ công tác quản lý lịch trực ban và phân công nhiệm vụ nội bộ. Mọi thông tin xác thực phải được lưu trữ an toàn trong biến môi trường và tuyệt đối không đưa lên kho mã nguồn công khai.