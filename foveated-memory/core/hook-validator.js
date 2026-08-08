/**
 * Minimal Hook Validation Helper
 * Validates that XRL hooks are correctly formatted before injection.
 */

function validateHook(hook) {
    if (!hook || typeof hook !== 'object') return false;
    const required = ['id', 'type', 'action'];
    return required.every(field => field in hook);
}

module.exports = { validateHook };
