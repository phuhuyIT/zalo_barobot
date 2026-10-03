# Pipeline đối chiếu ảnh báo cáo chia sẻ bài Facebook

*Bản thiết kế v2 · 01/10/2026 · Cập nhật: mỗi task chỉ có 1 ảnh mẫu (chính screenshot của người tạo task), media được crop tự động. Đã chạy thử trên 13 screenshot; các ngưỡng vẫn là giá trị khởi điểm, cần chỉnh thêm trên dữ liệu thật.*

## 1. Mục tiêu

Bot nhận link một bài viết Facebook, thu các ảnh báo cáo (screenshot bài đã được chia sẻ lên trang cá nhân) do người dùng nộp, và quyết định từng ảnh có đúng là ảnh chia sẻ bài đó hay không để tổng hợp báo cáo.

## 2. Ràng buộc

- Deploy trên Railway gói free: RAM và CPU nhỏ, phải chạy được trên thiết bị edge.
- Chấp nhận xử lý chậm, ưu tiên tiết kiệm tài nguyên.
- Không dùng model deep learning nặng trong luồng chính.

## 3. Ý tưởng cốt lõi

Trong screenshot, phần giao diện (dark/light, iOS/Android, thanh điều hướng, thời gian đăng, caption bị cắt ở các chỗ khác nhau) thay đổi liên tục. Phần media của bài được chia sẻ thì gần như bất biến, chỉ khác tỉ lệ. Vì vậy:

- Chỉ so sánh phần media, không so cả ảnh và không dùng OCR làm tiêu chí chính.
- Không huấn luyện model crop. Ảnh mẫu được crop tự động từ screenshot duy nhất của người tạo task bằng heuristic màu (bước A2), còn vùng media trong ảnh nộp được tự định vị nhờ khớp đặc trưng cục bộ.
- Vì chỉ có một ảnh mẫu, mọi bước phải chịu được khác biệt dark/light, iOS/Android và kích thước màn hình giữa ảnh mẫu và ảnh nộp.
- Thêm bước kiểm tra theo lưới ô để loại các bài cùng khuôn (ví dụ series hằng ngày chỉ khác ngày và đoạn văn) và collage cùng sự kiện.

## 4. Tổng quan luồng

```
Tạo task:   1 screenshot của người tạo -> tự động crop media (xác nhận) -> 1 ảnh mẫu
Ảnh nộp:    tiền xử lý -> SIFT + RANSAC (định vị) -> kiểm tra lưới ô -> PASS / REVIEW / FAIL
                                                    \-> (tùy chọn) OCR vùng header lấy tên người share
```

## 5. Giai đoạn A: đăng ký ảnh mẫu (mỗi task)

1. **A1. Nhận ảnh mẫu.** Người tạo task nộp một screenshot của chính mình (có khung bài được chia sẻ). Nên chọn ảnh đủ khung, không bị nút hay thanh điều hướng che.
2. **A2. Tự động crop media (không cần model).** Thu ảnh về chiều rộng 640px, tạo mặt nạ các điểm ảnh có độ bão hòa màu cao (S > 45 trong HSV). Phần giao diện Facebook gần như không có màu bão hòa, còn ảnh và đồ họa thì có. Tính tỉ lệ điểm ảnh bão hòa theo từng hàng (ngưỡng 0.20, cho phép khoảng trống tối đa 15 hàng) và lấy dải hàng liên tục dài nhất, rồi làm tương tự theo cột trong dải đó (ngưỡng 0.15). Kết quả là khung media.
3. **A3. Xác nhận khung (khuyến nghị).** Hiển thị khung tìm được cho người tạo task xem và kéo chỉnh nếu lệch. Chỉ có một ảnh mẫu nên crop lệch (lẫn tên người share, avatar) sẽ làm sai mọi phép so sau đó.
4. **A4. Lưu ảnh mẫu.** Crop theo khung, thu về chiều rộng 640px, tính SIFT một lần và giữ trong RAM, hoặc lưu file crop (PNG) để tính lại khi cần.
5. Không có ảnh mẫu thứ hai (dark/light, khác kích thước). Có thể bổ sung sau: mỗi khi người duyệt chốt PASS cho một ảnh nộp khác chế độ, thêm ảnh đó làm ảnh mẫu phụ (tùy chọn).

## 6. Giai đoạn B: xử lý ảnh nộp

### B1. Tiền xử lý

- Giải mã ảnh, áp dụng EXIF orientation, thu nhỏ về chiều rộng khoảng 640px, chuyển grayscale.

### B2. Khớp đặc trưng và định vị

- Trích SIFT (khoảng 1500 điểm) trên ảnh nộp, so với ảnh mẫu bằng `BFMatcher.knnMatch` (k=2) với ratio test 0.75.
- Ước lượng phép biến đổi bằng `cv2.estimateAffinePartial2D` (RANSAC, ngưỡng tái chiếu khoảng 4px). Dùng affine một phần (scale, xoay, dịch) thay vì homography để ít bậc tự do và bền hơn.
- Điều kiện qua bước này (giá trị khởi điểm): số inlier tối thiểu khoảng 25, tỉ lệ inlier tối thiểu khoảng 0.3, scale trong khoảng 0.3 đến 3, góc xoay nhỏ (dưới khoảng 5 độ).
- Chiếu khung ảnh mẫu lên ảnh nộp để có bounding box của media. Phần media nhìn thấy được trong ảnh nộp cần chiếm tối thiểu khoảng 65% ảnh mẫu (ảnh bị cắt mép vẫn được chấp nhận).

### B3. Kiểm tra lưới ô (chống bài cùng khuôn)

- Warp ảnh nộp về khung ảnh mẫu, chỉ xét vùng chồng lấn.
- Thu về chiều rộng khoảng 256px, lọc trung vị 5x5 rồi làm mờ Gauss nhẹ. Lọc trung vị xóa khe mỏng giữa các ảnh trong collage (khe đen ở chế độ dark, khe trắng ở chế độ light). Nếu không có bước này, ảnh nộp khác chế độ với ảnh mẫu bị trừ điểm oan (khoảng 0.83 đến 0.84 thay vì 1.00).
- Bỏ viền ngoài 4% mỗi cạnh rồi chia lưới 8x8. Viền card và góc bo tròn khác nhau giữa dark và light nên không dùng để so.
- Mỗi ô có ít nhất khoảng 70% diện tích nằm trong vùng chồng lấn thì được tính là ô hợp lệ. Ô hợp lệ khớp khi NCC (hệ số tương quan chuẩn hóa) từ khoảng 0.6 trở lên; ô gần như phẳng thì so độ sáng trung bình. Dùng numpy hoặc OpenCV, không cần scikit-image.
- Điểm lưới = số ô khớp / số ô hợp lệ.
- Ô chứa ngày hay đoạn chữ khác với ảnh mẫu sẽ không khớp, nên ảnh của bài hôm qua hay bài khác cùng khuôn bị loại.

### B4. Quyết định

| Điều kiện | Kết quả |
| --- | --- |
| Qua B2 và điểm lưới từ khoảng 0.85 trở lên | PASS |
| Qua B2 nhưng điểm lưới khoảng 0.6 đến dưới 0.85, hoặc inlier ở mức biên | REVIEW (người duyệt) |
| Không qua B2 và không định vị được | Thử B5, nếu vẫn không được thì FAIL hoặc REVIEW |
| Điểm lưới dưới khoảng 0.6 | FAIL |

Thiên về REVIEW thay vì tự duyệt khi không chắc, vì cái giá của một báo cáo sai lớn hơn cái giá của một lần duyệt tay.

### B5. Dự phòng cho ảnh ít đặc trưng

- Định vị bằng `cv2.matchTemplate` (TM\_CCOEFF\_NORMED) đa tỉ lệ trên ảnh nhỏ (khoảng 320px), thử scale 0.4 đến 1.5, rồi chạy lại B3 trên vùng tìm được.
- Tùy chọn: embedding nhỏ (DINOv2-small hoặc MobileNet dạng ONNX int8) trên vùng đã crop, chỉ dùng cho nhóm ca không chắc. Embedding global không dùng một mình vì dễ nhầm các bài cùng khuôn.
- Tùy chọn cuối: gọi API vision cho các ca vẫn lấp lửng.

### B6. OCR vùng header (tùy chọn, không dùng để quyết định)

- Cắt dải phía trên bounding box (chiều cao khoảng 0.8 lần chiều rộng media) rồi chạy Tesseract (`-l vie`, `--psm 6`) để lấy tên người share và chuỗi thời gian như `Vừa xong`.
- Kết quả chỉ để hiển thị và tổng hợp, không ảnh hưởng PASS hay FAIL.

## 7. Dữ liệu

- **Task**: id, link bài viết, thời điểm tạo, ảnh mẫu (một ảnh).
- **Ảnh mẫu**: id, task, screenshot gốc, khung crop (x0, y0, x1, y1), file crop media (PNG, chiều rộng khoảng 640px), tùy chọn descriptor SIFT. Có thể thêm ảnh mẫu phụ về sau.
- **Ảnh nộp**: id, task, hash file, kết quả (PASS/REVIEW/FAIL), điểm inlier, điểm lưới, bounding box, tên người share (nếu OCR), người duyệt và thời điểm duyệt.

Log điểm của mọi ảnh nộp, kể cả ảnh bị từ chối, để chỉnh ngưỡng sau này.

## 8. Tài nguyên

- Xử lý lần lượt từng ảnh, giới hạn đồng thời ở 1 tiến trình để tránh vượt RAM của gói free.
- Đo trong sandbox (chưa đo trên Railway): khoảng 30ms cho một lần khớp và định vị với một ảnh mẫu, khoảng 0.3 đến 0.4 giây cho toàn bộ xử lý một ảnh nộp (giải mã, SIFT, khớp, warp, lưới) khi chấm với 2 task. RAM chưa đo.
- Phụ thuộc chính: `opencv-python-headless` (4.5 trở lên, có SIFT), `numpy`, `pytesseract` và Tesseract (chỉ cho B6). Mô hình ONNX chỉ tải khi bật B5 tùy chọn.

## 9. Hiệu chỉnh và đánh giá

1. Tập dương: các screenshot đã duyệt tay. Tập thử hiện có 13 ảnh: 7 ảnh của bài collage 5 ảnh và 6 ảnh của bài đồ họa đơn.
2. Tập âm: ảnh của bài hôm qua, bài khác cùng Page, bài khác cùng sự kiện, ảnh không liên quan. Hiện chỉ có ca chéo giữa hai task và một ca âm giả lập (đổi ngày và đoạn văn), cần bổ sung ca âm thật.
3. Đo tỉ lệ PASS đúng, FAIL sai (bỏ sót) và REVIEW, rồi chỉnh các ngưỡng ở A2, B2 và B3. Ưu tiên không để lọt ảnh sai.
4. Mỗi lần người duyệt chốt một ca REVIEW, thêm vào tập dương hoặc âm.
5. Kết quả chạy thử (13 screenshot, mỗi ảnh lần lượt làm ảnh mẫu duy nhất, chấm 12 ảnh còn lại): với 72 cặp cùng task có 70 PASS và 2 REVIEW (điểm lưới 0.83 và 0.84, đều là collage khác chế độ), không có FAIL; với 84 cặp khác task cả 84 đều FAIL, không có PASS nhầm. Ca âm giả lập cùng khuôn ra REVIEW với điểm lưới 0.75. Crop tự động (A2) so với khung đo tay có IoU trung bình khoảng 0.98, thấp nhất khoảng 0.95. Tham số A2 và bước lọc trung vị được chọn sau khi xem kết quả trên chính 13 ảnh này, nên đây chưa phải kiểm chứng độc lập.

## 10. Giới hạn đã biết

- Ảnh quá mờ, bị chỉnh sửa mạnh, hoặc vùng media bị che quá nửa sẽ không khớp.
- Chỉ có một ảnh mẫu nên chất lượng crop ở A2 quyết định tất cả. Heuristic màu có thể sai với ảnh media ít màu (ảnh trắng đen, nền trắng); khi đó cần bước xác nhận A3 hoặc người tạo task chỉnh khung tay.
- Biên giữa ca dương thấp nhất (điểm lưới khoảng 0.83) và ca âm giả lập (khoảng 0.75) còn mỏng, ngưỡng PASS 0.85 sẽ đẩy một số ảnh đúng sang REVIEW. Cần thêm dữ liệu trước khi hạ ngưỡng.
- Collage đổi thứ tự hoặc số ảnh sẽ khác khung với ảnh mẫu; cần task riêng cho từng biến thể.
- Ảnh trơn ít chi tiết ít điểm SIFT, dễ phải dùng B5 hoặc REVIEW.
- Quy trình không xác minh nội dung chữ trong caption; nếu cần, bổ sung ở B6 như một tín hiệu phụ.

## 11. Phương án đã thử và lý do bỏ

- **OCR ảnh mẫu rồi so output OCR**: ảnh ít chữ bị nhiễu bởi tên account, độ lệch khi chụp và các chữ phát sinh.
- **Lấy caption từ unfurl rồi trượt cửa sổ trên kết quả OCR**: chỉ chạy tốt ở một số trường hợp nhất định, phụ thuộc chất lượng OCR của Tesseract.

Cả hai đều phụ thuộc vào chữ trong ảnh, trong khi phần ổn định và phân biệt tốt nhất của ảnh báo cáo là phần media.
