(() => {
  "use strict";
  const uploadInput = document.getElementById("imageInput");
  const cameraInput = document.getElementById("cameraInput");
  const clearBtn = document.getElementById("clearBtn");
  const ocrStatus = document.getElementById("ocrStatus");

  // The existing OCR engine reads #imageInput. Keep that engine unchanged and
  // mirror a newly captured camera file into the upload input before OCR runs.
  cameraInput?.addEventListener("change", () => {
    const file = cameraInput.files?.[0];
    if (!file || !uploadInput) return;
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      uploadInput.files = dt.files;
      uploadInput.dispatchEvent(new Event("change", { bubbles: true }));
      if (ocrStatus) ocrStatus.textContent = "ถ่ายรูปแล้ว — กด “อ่านข้อความจากรูป”";
    } catch (err) {
      // Very old browsers may not allow programmatic FileList assignment.
      if (ocrStatus) ocrStatus.textContent = "เบราว์เซอร์นี้ส่งรูปจากกล้องเข้า OCR ไม่ได้ กรุณาใช้ “เลือกรูป” แทน";
    }
  });

  clearBtn?.addEventListener("click", () => {
    if (cameraInput) cameraInput.value = "";
  });
})();
