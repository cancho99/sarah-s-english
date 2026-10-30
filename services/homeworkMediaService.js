// New homework files live in Storage; existing inline/external photos are never migrated.
window.SarahServices = window.SarahServices || {};
(function () {
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
  const MAX_ATTACHMENTS = 50;
  function validateFile(file, kind) {
    const allowed = kind === "image" ? /^image\/(jpeg|png|webp)$/ : /^audio\/(webm|mp4|mpeg|wav|x-wav|ogg|aac|x-m4a)(;.*)?$/;
    if (!file || !allowed.test(file.type || "")) throw new Error("지원하지 않는 파일 형식이에요. 사진 또는 녹음 파일을 선택해 주세요.");
    if (!file.size || file.size > (kind === "image" ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) throw new Error(kind === "image" ? "사진은 5MB 이하로 올려 주세요." : "녹음 파일은 15MB 이하로 올려 주세요.");
  }
  function appendAttachment(data, homeworkId, attachment) {
    const homework = data.homework || [];
    const target = homework.find((h) => h.id === homeworkId);
    if (!target || target.expired) throw new Error("제출할 수 없는 숙제예요. 새로고침 후 확인해 주세요.");
    if ((target.attachments || []).length >= MAX_ATTACHMENTS) throw new Error("숙제 하나에 파일을 최대 50개까지 제출할 수 있어요.");
    return { ...data, homework: homework.map((h) => h.id === homeworkId ? {
      ...h, attachments: [...(h.attachments || []), attachment], done: true, doneAt: Date.now(),
    } : h) };
  }
  async function upload(studentId, homeworkId, file, kind, updateData) {
    validateFile(file, kind);
    if (!window.__storage || !window.__uploadBytes) throw new Error("파일 저장소를 연결하지 못했어요. 잠시 후 다시 시도해 주세요.");
    const id = crypto.randomUUID();
    const path = `homeworkMedia/${encodeURIComponent(studentId)}/${encodeURIComponent(homeworkId)}/${id}`;
    const ref = window.__storageRef(window.__storage, path);
    await window.__uploadBytes(ref, file, { contentType: file.type });
    const attachment = { id, path, kind, name: (file.name || (kind === "audio" ? "녹음" : "사진")).slice(0, 120), contentType: file.type, size: file.size, uploadedAt: Date.now() };
    try {
      await updateData(studentId, (data) => appendAttachment(data, homeworkId, attachment));
    } catch (error) {
      // Only the brand-new unreferenced object is eligible for rollback, never old submissions.
      try { await window.__deleteObject(ref); } catch (_) { /* Preserve original save error. */ }
      throw error;
    }
    return attachment;
  }
  async function getUrl(attachment) {
    return window.__getDownloadURL(window.__storageRef(window.__storage, attachment.path));
  }
  window.SarahServices.homeworkMediaService = { upload, getUrl, validateFile, appendAttachment, MAX_IMAGE_BYTES, MAX_AUDIO_BYTES };
})();
