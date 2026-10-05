import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Langue de l'interface.
 *
 * Avant, le sélecteur de langue des réglages n'était qu'un `useState` local :
 * la valeur changeait dans le menu et absolument rien d'autre ne bougeait.
 * Ici la langue est un vrai état global, persisté, qui traduit réellement les
 * textes via `t()`.
 */
export type Locale = 'en' | 'fr' | 'es' | 'de' | 'nl';

export const LOCALES: { code: Locale; label: string; english: string; region: string }[] = [
  { code: 'en', label: 'English', english: 'English', region: 'United States' },
  { code: 'fr', label: 'Français', english: 'French', region: 'Belgique · France' },
  { code: 'es', label: 'Español', english: 'Spanish', region: 'España' },
  { code: 'de', label: 'Deutsch', english: 'German', region: 'Deutschland' },
  { code: 'nl', label: 'Nederlands', english: 'Dutch', region: 'België · Nederland' },
];

const STORAGE_KEY = 'velbaz_locale';

/** Dictionnaires. `en` est la référence : toute clé absente ailleurs retombe dessus. */
const DICT: Record<Locale, Record<string, string>> = {
  en: {
    'settings.title': 'Settings',
    'settings.nav.general': 'General',
    'settings.nav.ai': 'AI Behavior',
    'settings.nav.account': 'Account',

    'general.title': 'General',
    'general.desc': 'Manage notifications, language and appearance.',
    'general.notifications': 'Notifications',
    'general.push': 'Push Notifications',
    'general.push.desc': 'Get notified when agents complete tasks',
    'general.digest': 'Email Digest',
    'general.digest.desc': "Daily summary of your companies' activity",
    'general.heartbeat': 'Auto',
    'general.heartbeat.desc': 'The AI plans and runs tasks on its own (all projects)',
    'general.appearance': 'Appearance',
    'general.theme': 'Theme',
    'general.theme.dark': 'Currently using dark mode',
    'general.theme.light': 'Currently using light mode',

    'lang.card': 'Language & Region',
    'lang.label': 'Language',
    'lang.hint': 'The interface switches over immediately.',
    'lang.dialog.title': 'Choose your language',
    'lang.dialog.desc': 'Applies to the whole interface, right away.',
    'lang.current': 'Current',
    'lang.close': 'Close',

    // Verrou anti-force-brute de la connexion (cf. lib/login-lock.ts).
    'auth.invalid': "Wrong email or password.",
    'auth.attemptsLeft.one': "1 attempt left before a waiting period.",
    'auth.attemptsLeft.other': "{n} attempts left before a waiting period.",
    'auth.locked': "Too many attempts: for your security, sign-in is paused. Try again in {time}.",
    'auth.wait': "Wait {time}",

    'ai.title': 'AI Behavior',
    'ai.desc': 'Control how your AI agents make decisions and take actions.',

    'account.title': 'Account',
    'account.desc': 'Manage your profile, plan and session.',
    'account.edit': 'Edit Profile',
    'account.plan': 'Plan',
    'account.session': 'Session',
    'account.signedIn': 'Currently signed in',
    'account.signOut': 'Sign Out',
    // [2026-09-15] Chat & aperçu — ces textes étaient codés en dur en anglais
    // dans pages/chat.tsx alors que le reste de l'interface était traduit :
    // on se retrouvait avec « Start a conversation » au-dessus de réglages en
    // français. Tout passe désormais par `t()`.
    'chat.empty': 'Start a conversation with {brand}',
    'chat.responding': '{brand} is responding',
    'chat.ph.ask': 'Ask {brand} anything…',
    'chat.ph.task': 'Give {brand} a task…',
    'chat.ph.busy': 'The AI is replying…',
    'chat.ph.listening': 'Speak now…',
    'chat.copy': 'Copy message',
    'chat.copied': 'Message copied',
    'chat.openTab': 'Open in a new tab',
    'chat.refresh': 'Refresh preview',
    'chat.workDone': 'Work done',
    'chat.jump': 'Back to the bottom',
    'chat.jump.new': 'New messages',
    'chat.steps': 'steps',

    // ── Un seul niveau : « Step · N tasks », et le résumé de fin ──
    'step.label': 'Step',
    'step.task': 'task',
    'step.tasks': 'tasks',
    // [2026-09-19] Le nom du paquet vient de ce qu'il contient, pas du mot
    // « Step » répété à l'identique sur toute la page. La catégorie est déjà
    // calculée (getTaskGroup), on ne fait que la nommer ici.
    'step.name.research': 'Research',
    'step.name.analysis': 'Analysis',
    'step.name.brand': 'Brand identity',
    'step.name.marketing': 'Marketing',
    'step.name.content': 'Content',
    'step.name.development': 'Development',
    'step.name.design': 'Design',
    'step.name.testing': 'Checks',
    'step.name.deployment': 'Going live',
    'step.name.team': 'Team',
    'run.completed': 'Completed {n} steps',
    'run.completed.one': 'Completed 1 step',

    'chat.open': 'Open',

    // Notification de fin de build (titre d'onglet + notification système).
    'notif.build.title': 'Your site is ready',
    'notif.build.body': '{brand} finished the build.',
    'notif.build.failed': 'The build stopped before the end.',
    'notif.build.running': 'Building',
    'toast.fileTooLarge': 'File "{name}" is too large (max 10 MB)',
    'prompt.tooLong': 'Too many characters: {count} / {max}. Shorten your message, or paste the long text — it becomes an attached file.',
    'prompt.pastedFile': 'Pasted text',
    'prompt.pastedAsFile': 'Long text attached as a file ({count} characters)',
    'prompt.charsLeft': '{left} characters left',
    'prompt.viewer.chars': '{count} characters',
    'prompt.viewer.close': 'Close',
    'prompt.viewer.copy': 'Copy',
    'prompt.viewer.copied': 'Copied',
    'toast.dismiss': 'Dismiss',
    'egg.name.skynet': "Project “Skynet” saved. One quick clarification before we start: I build websites, not autonomous defence networks. Let’s stick to the website.",
    'egg.name.hal': "I’m sorry Dave, I’m afraid I can’t do that.\n\n…actually I can. That was for the name. Ready when you are.",
    'egg.name.jarvis': "At your service. Reactors cold, coffee hot. Where shall we start, sir?",
    'notif.tab.done': 'Done',
    'notif.tab.failed': 'Failed',
    'notif.build.failedTitle': 'Build interrupted',
    'notif.tab.question': 'Question',
    'notif.question.title': 'Waiting for your answer',
    'notif.question.body': 'The AI asked you a question.',

    'build.done.ready': "Your project is ready. Take a look in the preview, then tell me what you'd like to change.",
    'build.done.failed': "Almost ready — just a small finishing touch left. Resend your request and I'll pick up right where I left off. 🔄",
  },
  fr: {
    'settings.title': 'Réglages',
    'settings.nav.general': 'Général',
    'settings.nav.ai': "Comportement de l'IA",
    'settings.nav.account': 'Compte',

    'general.title': 'Général',
    'general.desc': "Notifications, langue et apparence.",
    'general.notifications': 'Notifications',
    'general.push': 'Notifications push',
    'general.push.desc': 'Être prévenu quand les agents terminent une tâche',
    'general.digest': 'Résumé par e-mail',
    'general.digest.desc': "Résumé quotidien de l'activité de tes projets",
    'general.heartbeat': 'Auto',
    'general.heartbeat.desc': "L'IA planifie et exécute les tâches toute seule (tous les projets)",
    'general.appearance': 'Apparence',
    'general.theme': 'Thème',
    'general.theme.dark': 'Mode sombre activé',
    'general.theme.light': 'Mode clair activé',

    'lang.card': 'Langue et région',
    'lang.label': 'Langue',
    'lang.hint': "L'interface change tout de suite.",
    'lang.dialog.title': 'Choisis ta langue',
    'lang.dialog.desc': "S'applique à toute l'interface, immédiatement.",
    'lang.current': 'Actuelle',
    'lang.close': 'Fermer',

    // Verrou anti-force-brute de la connexion (cf. lib/login-lock.ts).
    'auth.invalid': "E-mail ou mot de passe incorrect.",
    'auth.attemptsLeft.one': "Encore 1 essai avant un délai d'attente.",
    'auth.attemptsLeft.other': "Encore {n} essais avant un délai d'attente.",
    'auth.locked': "Trop de tentatives : par sécurité, la connexion est en pause. Réessaie dans {time}.",
    'auth.wait': "Patiente {time}",

    'ai.title': "Comportement de l'IA",
    'ai.desc': "Contrôle la façon dont tes agents décident et agissent.",

    'account.title': 'Compte',
    'account.desc': 'Profil, formule et session.',
    'account.edit': 'Modifier le profil',
    'account.plan': 'Formule',
    'account.session': 'Session',
    'account.signedIn': 'Connecté actuellement',
    'account.signOut': 'Se déconnecter',
    'chat.empty': 'Démarre une conversation avec {brand}',
    'chat.responding': '{brand} répond',
    'chat.ph.ask': 'Demande ce que tu veux à {brand}…',
    'chat.ph.task': 'Donne une tâche à {brand}…',
    'chat.ph.busy': "L'IA est en train de répondre…",
    'chat.ph.listening': 'Parle maintenant…',
    'chat.copy': 'Copier le message',
    'chat.copied': 'Message copié',
    'chat.openTab': 'Ouvrir dans un nouvel onglet',
    'chat.refresh': "Recharger l'aperçu",
    'chat.workDone': 'Travail terminé',
    'chat.jump': 'Revenir en bas',
    'chat.jump.new': 'Nouveaux messages',
    'chat.steps': 'étapes',

    // ── Un seul niveau : « Étape · N tâches », et le résumé de fin ──
    'step.label': 'Étape',
    'step.task': 'tâche',
    'step.tasks': 'tâches',
    'step.name.research': 'Recherche',
    'step.name.analysis': 'Analyse',
    'step.name.brand': 'Identité de marque',
    'step.name.marketing': 'Marketing',
    'step.name.content': 'Contenu',
    'step.name.development': 'Développement',
    'step.name.design': 'Design',
    'step.name.testing': 'Vérifications',
    'step.name.deployment': 'Mise en ligne',
    'step.name.team': 'Équipe',
    'run.completed': '{n} étapes terminées',
    'run.completed.one': '1 étape terminée',

    'chat.open': 'Ouvrir',

    'notif.build.title': 'Ton site est prêt',
    'notif.build.body': '{brand} a fini de construire.',
    'notif.build.failed': "La construction s'est arrêtée avant la fin.",
    'notif.build.running': 'Construction',
    'toast.fileTooLarge': 'Le fichier « {name} » est trop lourd (10 Mo maximum)',
    'prompt.tooLong': 'Trop de caractères : {count} / {max}. Raccourcis ton message, ou colle le texte long — il devient un fichier joint.',
    'prompt.pastedFile': 'Texte collé',
    'prompt.pastedAsFile': 'Texte long joint en fichier ({count} caractères)',
    'prompt.charsLeft': '{left} caractères restants',
    'prompt.viewer.chars': '{count} caractères',
    'prompt.viewer.close': 'Fermer',
    'prompt.viewer.copy': 'Copier',
    'prompt.viewer.copied': 'Copié',
    'toast.dismiss': 'Masquer',
    'egg.name.skynet': "Projet « Skynet » enregistré. Petite mise au point avant de commencer : je fais des sites, pas des réseaux de défense autonomes. On reste sur le site.",
    'egg.name.hal': "I’m sorry Dave, I’m afraid I can’t do that.\n\n…enfin si, je peux. C’était pour le nom. On commence quand tu veux.",
    'egg.name.jarvis': "À votre service. Réacteurs froids, cafetière chaude. Par quoi on commence, monsieur ?",
    'notif.tab.done': 'Terminé',
    'notif.tab.failed': 'Échec',
    'notif.build.failedTitle': 'Construction interrompue',
    'notif.tab.question': 'Question',
    'notif.question.title': 'En attente de ta réponse',
    'notif.question.body': "L'IA t'a posé une question.",

    'build.done.ready': "Ton projet est prêt. Jette un œil à l'aperçu, puis dis-moi ce que tu veux changer.",
    'build.done.failed': "Presque prêt — il reste une petite finition. Renvoie ta demande, je reprends exactement là où je me suis arrêté. 🔄",
  },
  es: {
    'settings.title': 'Ajustes',
    'settings.nav.general': 'General',
    'settings.nav.ai': 'Comportamiento de la IA',
    'settings.nav.account': 'Cuenta',

    'general.title': 'General',
    'general.desc': 'Notificaciones, idioma y apariencia.',
    'general.notifications': 'Notificaciones',
    'general.push': 'Notificaciones push',
    'general.push.desc': 'Recibe avisos cuando los agentes terminan tareas',
    'general.digest': 'Resumen por correo',
    'general.digest.desc': 'Resumen diario de la actividad de tus proyectos',
    'general.heartbeat': 'Auto',
    'general.heartbeat.desc': 'Los agentes trabajan solos cada día (todos los proyectos)',
    'general.appearance': 'Apariencia',
    'general.theme': 'Tema',
    'general.theme.dark': 'Modo oscuro activado',
    'general.theme.light': 'Modo claro activado',

    'lang.card': 'Idioma y región',
    'lang.label': 'Idioma',
    'lang.hint': 'La interfaz cambia al instante.',
    'lang.dialog.title': 'Elige tu idioma',
    'lang.dialog.desc': 'Se aplica a toda la interfaz, de inmediato.',
    'lang.current': 'Actual',
    'lang.close': 'Cerrar',

    // Verrou anti-force-brute de la connexion (cf. lib/login-lock.ts).
    'auth.invalid': "Correo o contraseña incorrectos.",
    'auth.attemptsLeft.one': "Te queda 1 intento antes de una espera.",
    'auth.attemptsLeft.other': "Te quedan {n} intentos antes de una espera.",
    'auth.locked': "Demasiados intentos: por seguridad, el inicio de sesión está en pausa. Vuelve a intentarlo en {time}.",
    'auth.wait': "Espera {time}",

    'ai.title': 'Comportamiento de la IA',
    'ai.desc': 'Controla cómo deciden y actúan tus agentes.',

    'account.title': 'Cuenta',
    'account.desc': 'Perfil, plan y sesión.',
    'account.edit': 'Editar perfil',
    'account.plan': 'Plan',
    'account.session': 'Sesión',
    'account.signedIn': 'Sesión iniciada',
    'account.signOut': 'Cerrar sesión',
    'chat.empty': 'Empieza una conversación con {brand}',
    'chat.responding': '{brand} está respondiendo',
    'chat.ph.ask': 'Pregúntale lo que quieras a {brand}…',
    'chat.ph.task': 'Dale una tarea a {brand}…',
    'chat.ph.busy': 'La IA está respondiendo…',
    'chat.ph.listening': 'Habla ahora…',
    'chat.copy': 'Copiar mensaje',
    'chat.copied': 'Mensaje copiado',
    'chat.openTab': 'Abrir en una pestaña nueva',
    'chat.refresh': 'Recargar la vista previa',
    'chat.workDone': 'Trabajo terminado',
    'chat.jump': 'Volver abajo',
    'chat.jump.new': 'Mensajes nuevos',
    'chat.steps': 'pasos',

    // ── Un solo nivel: « Paso · N tareas », y el resumen final ──
    'step.label': 'Paso',
    'step.task': 'tarea',
    'step.tasks': 'tareas',
    'step.name.research': 'Investigación',
    'step.name.analysis': 'Análisis',
    'step.name.brand': 'Identidad de marca',
    'step.name.marketing': 'Marketing',
    'step.name.content': 'Contenido',
    'step.name.development': 'Desarrollo',
    'step.name.design': 'Diseño',
    'step.name.testing': 'Comprobaciones',
    'step.name.deployment': 'Publicación',
    'step.name.team': 'Equipo',
    'run.completed': '{n} pasos completados',
    'run.completed.one': '1 paso completado',

    'chat.open': 'Abrir',

    'notif.build.title': 'Tu sitio está listo',
    'notif.build.body': '{brand} ha terminado la construcción.',
    'notif.build.failed': 'La construcción se detuvo antes de terminar.',
    'notif.build.running': 'Construyendo',
    'toast.fileTooLarge': 'El archivo «{name}» es demasiado grande (máx. 10 MB)',
    'prompt.tooLong': 'Demasiados caracteres: {count} / {max}. Acorta tu mensaje, o pega el texto largo — se adjunta como archivo.',
    'prompt.pastedFile': 'Texto pegado',
    'prompt.pastedAsFile': 'Texto largo adjuntado como archivo ({count} caracteres)',
    'prompt.charsLeft': 'Quedan {left} caracteres',
    'prompt.viewer.chars': '{count} caracteres',
    'prompt.viewer.close': 'Cerrar',
    'prompt.viewer.copy': 'Copiar',
    'prompt.viewer.copied': 'Copiado',
    'toast.dismiss': 'Descartar',
    'egg.name.skynet': "Proyecto «Skynet» guardado. Una aclaración antes de empezar: hago sitios web, no redes de defensa autónomas. Sigamos con el sitio.",
    'egg.name.hal': "I’m sorry Dave, I’m afraid I can’t do that.\n\n…bueno, sí puedo. Era por el nombre. Empezamos cuando quieras.",
    'egg.name.jarvis': "A su servicio. Reactores fríos, café caliente. ¿Por dónde empezamos, señor?",
    'notif.tab.done': 'Listo',
    'notif.tab.failed': 'Error',
    'notif.build.failedTitle': 'Construcción interrumpida',
    'notif.tab.question': 'Pregunta',
    'notif.question.title': 'Esperando tu respuesta',
    'notif.question.body': 'La IA te hizo una pregunta.',

    'build.done.ready': "Tu proyecto está listo. Échale un vistazo en la vista previa y dime qué quieres cambiar.",
    'build.done.failed': "Casi listo — solo falta un pequeño retoque. Vuelve a enviar tu solicitud y retomaré justo donde lo dejé. 🔄",
  },
  de: {
    'settings.title': 'Einstellungen',
    'settings.nav.general': 'Allgemein',
    'settings.nav.ai': 'KI-Verhalten',
    'settings.nav.account': 'Konto',

    'general.title': 'Allgemein',
    'general.desc': 'Benachrichtigungen, Sprache und Aussehen.',
    'general.notifications': 'Benachrichtigungen',
    'general.push': 'Push-Benachrichtigungen',
    'general.push.desc': 'Bescheid bekommen, wenn Agenten Aufgaben abschließen',
    'general.digest': 'E-Mail-Zusammenfassung',
    'general.digest.desc': 'Tägliche Zusammenfassung deiner Projekte',
    'general.heartbeat': 'Auto',
    'general.heartbeat.desc': 'Agenten arbeiten täglich selbstständig (alle Projekte)',
    'general.appearance': 'Aussehen',
    'general.theme': 'Design',
    'general.theme.dark': 'Dunkles Design aktiv',
    'general.theme.light': 'Helles Design aktiv',

    'lang.card': 'Sprache und Region',
    'lang.label': 'Sprache',
    'lang.hint': 'Die Oberfläche wechselt sofort.',
    'lang.dialog.title': 'Sprache wählen',
    'lang.dialog.desc': 'Gilt sofort für die gesamte Oberfläche.',
    'lang.current': 'Aktuell',
    'lang.close': 'Schließen',

    // Verrou anti-force-brute de la connexion (cf. lib/login-lock.ts).
    'auth.invalid': "E-Mail oder Passwort falsch.",
    'auth.attemptsLeft.one': "Noch 1 Versuch vor einer Wartezeit.",
    'auth.attemptsLeft.other': "Noch {n} Versuche vor einer Wartezeit.",
    'auth.locked': "Zu viele Versuche: Zu deiner Sicherheit ist die Anmeldung pausiert. Versuche es in {time} erneut.",
    'auth.wait': "Warte {time}",

    'ai.title': 'KI-Verhalten',
    'ai.desc': 'Steuere, wie deine Agenten entscheiden und handeln.',

    'account.title': 'Konto',
    'account.desc': 'Profil, Tarif und Sitzung.',
    'account.edit': 'Profil bearbeiten',
    'account.plan': 'Tarif',
    'account.session': 'Sitzung',
    'account.signedIn': 'Aktuell angemeldet',
    'account.signOut': 'Abmelden',
    'chat.empty': 'Starte ein Gespräch mit {brand}',
    'chat.responding': '{brand} antwortet',
    'chat.ph.ask': 'Frag {brand} alles…',
    'chat.ph.task': 'Gib {brand} eine Aufgabe…',
    'chat.ph.busy': 'Die KI antwortet gerade…',
    'chat.ph.listening': 'Sprich jetzt…',
    'chat.copy': 'Nachricht kopieren',
    'chat.copied': 'Nachricht kopiert',
    'chat.openTab': 'In neuem Tab öffnen',
    'chat.refresh': 'Vorschau neu laden',
    'chat.workDone': 'Arbeit fertig',
    'chat.jump': 'Zurück nach unten',
    'chat.jump.new': 'Neue Nachrichten',
    'chat.steps': 'Schritte',

    // ── Nur eine Ebene: « Schritt · N Aufgaben », plus Abschluss ──
    'step.label': 'Schritt',
    'step.task': 'Aufgabe',
    'step.tasks': 'Aufgaben',
    'step.name.research': 'Recherche',
    'step.name.analysis': 'Analyse',
    'step.name.brand': 'Markenidentität',
    'step.name.marketing': 'Marketing',
    'step.name.content': 'Inhalte',
    'step.name.development': 'Entwicklung',
    'step.name.design': 'Design',
    'step.name.testing': 'Prüfungen',
    'step.name.deployment': 'Veröffentlichung',
    'step.name.team': 'Team',
    'run.completed': '{n} Schritte erledigt',
    'run.completed.one': '1 Schritt erledigt',

    'chat.open': 'Öffnen',

    'notif.build.title': 'Deine Website ist fertig',
    'notif.build.body': '{brand} hat den Build abgeschlossen.',
    'notif.build.failed': 'Der Build wurde vorzeitig abgebrochen.',
    'notif.build.running': 'Build',
    'toast.fileTooLarge': 'Die Datei „{name}“ ist zu groß (max. 10 MB)',
    'prompt.tooLong': 'Zu viele Zeichen: {count} / {max}. Kürze die Nachricht, oder füge den langen Text ein — er wird als Datei angehängt.',
    'prompt.pastedFile': 'Eingefügter Text',
    'prompt.pastedAsFile': 'Langer Text als Datei angehängt ({count} Zeichen)',
    'prompt.charsLeft': 'Noch {left} Zeichen',
    'prompt.viewer.chars': '{count} Zeichen',
    'prompt.viewer.close': 'Schließen',
    'prompt.viewer.copy': 'Kopieren',
    'prompt.viewer.copied': 'Kopiert',
    'toast.dismiss': 'Ausblenden',
    'egg.name.skynet': "Projekt „Skynet“ gespeichert. Kurze Klarstellung vorab: ich baue Websites, keine autonomen Verteidigungsnetze. Bleiben wir bei der Website.",
    'egg.name.hal': "I’m sorry Dave, I’m afraid I can’t do that.\n\n…doch, kann ich. Das war nur wegen des Namens. Los, wann du willst.",
    'egg.name.jarvis': "Zu Ihren Diensten. Reaktoren kalt, Kaffee heiß. Womit fangen wir an, Sir?",
    'notif.tab.done': 'Fertig',
    'notif.tab.failed': 'Fehler',
    'notif.build.failedTitle': 'Build abgebrochen',
    'notif.tab.question': 'Frage',
    'notif.question.title': 'Wartet auf deine Antwort',
    'notif.question.body': 'Die KI hat dir eine Frage gestellt.',

    'build.done.ready': "Dein Projekt ist fertig. Schau es dir in der Vorschau an und sag mir, was du ändern möchtest.",
    'build.done.failed': "Fast fertig — nur noch ein kleiner Feinschliff. Sende deine Anfrage noch einmal, dann mache ich genau dort weiter. 🔄",
  },
  nl: {
    'settings.title': 'Instellingen',
    'settings.nav.general': 'Algemeen',
    'settings.nav.ai': 'AI-gedrag',
    'settings.nav.account': 'Account',

    'general.title': 'Algemeen',
    'general.desc': 'Meldingen, taal en weergave.',
    'general.notifications': 'Meldingen',
    'general.push': 'Pushmeldingen',
    'general.push.desc': 'Krijg bericht wanneer agenten taken afronden',
    'general.digest': 'E-mailsamenvatting',
    'general.digest.desc': 'Dagelijkse samenvatting van je projecten',
    'general.heartbeat': 'Auto',
    'general.heartbeat.desc': 'Agenten werken elke dag zelfstandig (alle projecten)',
    'general.appearance': 'Weergave',
    'general.theme': 'Thema',
    'general.theme.dark': 'Donkere modus actief',
    'general.theme.light': 'Lichte modus actief',

    'lang.card': 'Taal en regio',
    'lang.label': 'Taal',
    'lang.hint': 'De interface schakelt meteen over.',
    'lang.dialog.title': 'Kies je taal',
    'lang.dialog.desc': 'Geldt direct voor de hele interface.',
    'lang.current': 'Huidige',
    'lang.close': 'Sluiten',

    // Verrou anti-force-brute de la connexion (cf. lib/login-lock.ts).
    'auth.invalid': "Onjuist e-mailadres of wachtwoord.",
    'auth.attemptsLeft.one': "Nog 1 poging voor een wachttijd.",
    'auth.attemptsLeft.other': "Nog {n} pogingen voor een wachttijd.",
    'auth.locked': "Te veel pogingen: voor je veiligheid is inloggen gepauzeerd. Probeer het opnieuw over {time}.",
    'auth.wait': "Wacht {time}",

    'ai.title': 'AI-gedrag',
    'ai.desc': 'Bepaal hoe je agenten beslissen en handelen.',

    'account.title': 'Account',
    'account.desc': 'Profiel, abonnement en sessie.',
    'account.edit': 'Profiel bewerken',
    'account.plan': 'Abonnement',
    'account.session': 'Sessie',
    'account.signedIn': 'Momenteel ingelogd',
    'account.signOut': 'Afmelden',
    'chat.empty': 'Begin een gesprek met {brand}',
    'chat.responding': '{brand} antwoordt',
    'chat.ph.ask': 'Vraag {brand} wat je wil…',
    'chat.ph.task': 'Geef {brand} een taak…',
    'chat.ph.busy': 'De AI is aan het antwoorden…',
    'chat.ph.listening': 'Spreek nu…',
    'chat.copy': 'Bericht kopiëren',
    'chat.copied': 'Bericht gekopieerd',
    'chat.openTab': 'In een nieuw tabblad openen',
    'chat.refresh': 'Voorbeeld herladen',
    'chat.workDone': 'Werk klaar',
    'chat.jump': 'Terug naar onderen',
    'chat.jump.new': 'Nieuwe berichten',
    'chat.steps': 'stappen',

    // ── Eén niveau: « Stap · N taken », plus de slotsamenvatting ──
    'step.label': 'Stap',
    'step.task': 'taak',
    'step.tasks': 'taken',
    'step.name.research': 'Onderzoek',
    'step.name.analysis': 'Analyse',
    'step.name.brand': 'Merkidentiteit',
    'step.name.marketing': 'Marketing',
    'step.name.content': 'Content',
    'step.name.development': 'Ontwikkeling',
    'step.name.design': 'Ontwerp',
    'step.name.testing': 'Controles',
    'step.name.deployment': 'Live zetten',
    'step.name.team': 'Team',
    'run.completed': '{n} stappen afgerond',
    'run.completed.one': '1 stap afgerond',

    'chat.open': 'Openen',

    'notif.build.title': 'Je site is klaar',
    'notif.build.body': '{brand} is klaar met bouwen.',
    'notif.build.failed': 'De build is voortijdig gestopt.',
    'notif.build.running': 'Bouwen',
    'toast.fileTooLarge': 'Bestand "{name}" is te groot (max. 10 MB)',
    'prompt.tooLong': 'Te veel tekens: {count} / {max}. Maak je bericht korter, of plak de lange tekst — die wordt als bestand toegevoegd.',
    'prompt.pastedFile': 'Geplakte tekst',
    'prompt.pastedAsFile': 'Lange tekst toegevoegd als bestand ({count} tekens)',
    'prompt.charsLeft': 'Nog {left} tekens',
    'prompt.viewer.chars': '{count} tekens',
    'prompt.viewer.close': 'Sluiten',
    'prompt.viewer.copy': 'Kopiëren',
    'prompt.viewer.copied': 'Gekopieerd',
    'toast.dismiss': 'Verbergen',
    'egg.name.skynet': "Project “Skynet” opgeslagen. Eén verduidelijking vooraf: ik maak websites, geen autonome verdedigingsnetwerken. We houden het bij de site.",
    'egg.name.hal': "I’m sorry Dave, I’m afraid I can’t do that.\n\n…nou ja, dat kan ik wel. Het was om de naam. We beginnen wanneer je wil.",
    'egg.name.jarvis': "Tot uw dienst. Reactoren koud, koffie warm. Waar beginnen we, meneer?",
    'notif.tab.done': 'Klaar',
    'notif.tab.failed': 'Mislukt',
    'notif.build.failedTitle': 'Build afgebroken',
    'notif.tab.question': 'Vraag',
    'notif.question.title': 'Wacht op je antwoord',
    'notif.question.body': 'De AI heeft je een vraag gesteld.',

    'build.done.ready': "Je project is klaar. Bekijk het in de preview en zeg me wat je wilt aanpassen.",
    'build.done.failed': "Bijna klaar — er rest nog een kleine afwerking. Stuur je vraag opnieuw, dan ga ik verder waar ik gebleven was. 🔄",
  },
};

function readStored(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as Locale | null;
    if (v && DICT[v]) return v;
    const nav = (navigator.language || 'en').slice(0, 2) as Locale;
    if (DICT[nav]) return nav;
  } catch { /* stockage indisponible */ }
  return 'en';
}

interface I18nValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  /**
   * `vars` remplit les jetons `{nom}` du texte traduit — indispensable pour les
   * phrases où le nom de la marque est au milieu (« Demande ce que tu veux à
   * Velbaz »), dont l'ordre des mots change d'une langue à l'autre.
   */
  t: (key: string, vars?: Record<string, string>) => string;
}

/** Remplace les jetons `{nom}` par leur valeur. */
function fill(text: string, vars?: Record<string, string>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

const I18nContext = createContext<I18nValue>({
  locale: 'en',
  setLocale: () => {},
  t: (k, vars) => fill(DICT.en[k] ?? k, vars),
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStored());

  // La langue suit l'utilisateur d'un onglet et d'une session à l'autre, et
  // `<html lang>` est mis à jour pour l'accessibilité et le navigateur.
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, locale); } catch { /* ignoré */ }
    if (typeof document !== 'undefined') document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((l: Locale) => { if (DICT[l]) setLocaleState(l); }, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string>) => fill(DICT[locale][key] ?? DICT.en[key] ?? key, vars),
    [locale],
  );
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Traduction HORS composant React (stores, utilitaires) : même dictionnaire,
 * dans la langue choisie par l'utilisateur (ou celle du navigateur).
 */
export function translate(key: string, vars?: Record<string, string>): string {
  const locale = readStored();
  return fill(DICT[locale][key] ?? DICT.en[key] ?? key, vars);
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
