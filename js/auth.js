/**
 * auth.js — Modulo autenticazione locale
 * -------------------------------------------------------
 * Gestisce utenti, sessioni e ruoli senza backend.
 * I dati sono persistiti in localStorage.
 * Ruoli: admin | user
 * -------------------------------------------------------
 */

const Auth = (() => {

  // ── Chiavi localStorage ──
  const KEY_USERS   = 'circuitlab_users';
  const KEY_SESSION = 'circuitlab_session';

  // ── Codici invito validi (opzionale) ──
  const VALID_INVITE_CODES = ['CIRCUIT-2024', 'ELETTRO-LAB', 'OHM-RULES'];

  // ── Utenti predefiniti (admin di sistema) ──
  const DEFAULT_USERS = [
    { username: 'recruteur', password: 'moreone', role: 'admin', createdAt: Date.now() }
  ];

  /**
   * Inizializza il database utenti nel localStorage.
   * Eseguito una volta sola al primo avvio.
   */
  function init() {
    if (!localStorage.getItem(KEY_USERS)) {
      localStorage.setItem(KEY_USERS, JSON.stringify(DEFAULT_USERS));
    }
  }

  /**
   * Restituisce tutti gli utenti registrati.
   * @returns {Array} lista utenti
   */
  function getUsers() {
    return JSON.parse(localStorage.getItem(KEY_USERS) || '[]');
  }

  /**
   * Salva la lista utenti nel localStorage.
   * @param {Array} users
   */
  function saveUsers(users) {
    localStorage.setItem(KEY_USERS, JSON.stringify(users));
  }

  /**
   * Tentativo di login.
   * @param {string} username
   * @param {string} password
   * @returns {{ success: boolean, error?: string, user?: object }}
   */
  function login(username, password) {
    const users = getUsers();
    const user  = users.find(u =>
      u.username.toLowerCase() === username.toLowerCase() &&
      u.password === password
    );

    if (!user) {
      return { success: false, error: 'Credenziali non valide.' };
    }

    // Salva sessione
    const session = { username: user.username, role: user.role, loginAt: Date.now() };
    localStorage.setItem(KEY_SESSION, JSON.stringify(session));

    return { success: true, user: session };
  }

  /**
   * Registrazione nuovo utente.
   * @param {string} username
   * @param {string} password
   * @param {string} inviteCode - opzionale, richiesto se REQUIRE_INVITE = true
   * @returns {{ success: boolean, error?: string }}
   */
  function register(username, password, inviteCode = '') {
    if (!username || username.length < 3) {
      return { success: false, error: 'Username troppo corto (min 3 caratteri).' };
    }
    if (!password || password.length < 6) {
      return { success: false, error: 'Password troppo corta (min 6 caratteri).' };
    }

    // Verifica codice invito se presente nel campo
    if (inviteCode && !VALID_INVITE_CODES.includes(inviteCode.trim().toUpperCase())) {
      return { success: false, error: 'Codice invito non valido.' };
    }

    const users = getUsers();
    const exists = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (exists) {
      return { success: false, error: 'Username già in uso.' };
    }

    // Crea nuovo utente con ruolo base
    const newUser = { username, password, role: 'user', createdAt: Date.now() };
    users.push(newUser);
    saveUsers(users);

    // Login automatico
    return login(username, password);
  }

  /**
   * Logout: elimina la sessione attiva.
   */
  function logout() {
    localStorage.removeItem(KEY_SESSION);
  }

  /**
   * Restituisce la sessione corrente (o null se non loggato).
   * @returns {object|null}
   */
  function getSession() {
    const raw = localStorage.getItem(KEY_SESSION);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Verifica se l'utente ha un certo ruolo.
   * @param {string} role
   * @returns {boolean}
   */
  function hasRole(role) {
    const session = getSession();
    return session && session.role === role;
  }

  // Espone le funzioni pubbliche
  return { init, login, register, logout, getSession, hasRole };

})();
