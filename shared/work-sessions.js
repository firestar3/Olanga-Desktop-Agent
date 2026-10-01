(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OlangaWorkSessions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function sessionName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Use a session name between 1 and 80 characters.');
    return value.trim();
  }
  function validBounds(value) {
    return !!value && ['left', 'top', 'right', 'bottom'].every(key => Number.isInteger(value[key]) && Math.abs(value[key]) <= 100000) && value.right - value.left >= 80 && value.bottom - value.top >= 50 && value.right - value.left <= 30000 && value.bottom - value.top <= 30000;
  }
  function restoreSummary(receipts) {
    const completed = receipts.filter(item => item.ok).length;
    const failed = receipts.filter(item => !item.ok && item.status !== 'cancelled').length;
    const cancelled = receipts.filter(item => item.status === 'cancelled').length;
    return { completed, failed, cancelled, message: `${completed} window${completed === 1 ? '' : 's'} restored${failed ? `, ${failed} needing attention` : ''}${cancelled ? `, ${cancelled} cancelled` : ''}.` };
  }
  return { sessionName, validBounds, restoreSummary };
});
