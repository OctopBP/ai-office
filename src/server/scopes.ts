// Области имён пакетов. Модуль без импортов намеренно: roles.ts читает
// OFFICIAL_SCOPE при загрузке, а packages.ts → permissions.ts → subprojects.ts →
// roles.ts замыкаются в круг, и константа из packages.ts там ещё не готова.

/** Область наших пакетов. Зарезервирована: чужой пакет так называться не может. */
export const OFFICIAL_SCOPE = '@office';
