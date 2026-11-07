// Languages a series can be studied in. English is always the language of the
// translations, so it isn't listed here.

export const LANGUAGES = {
  es: {
    code: 'es', name: 'Spanish', nativeName: 'Español', linguee: 'spanish', deeplTarget: 'ES', ponsVerbTables: true,
    subtitleTags: ['es-419', 'es', 'es-ES', 'es-MX', 'spa'], audioTags: ['spa', 'es'],
  },
  fr: {
    code: 'fr', name: 'French', nativeName: 'Français', linguee: 'french', deeplTarget: 'FR', ponsVerbTables: true,
    subtitleTags: ['fr', 'fr-FR', 'fr-CA', 'fra', 'fre'], audioTags: ['fra', 'fre', 'fr'],
  },
  de: {
    code: 'de', name: 'German', nativeName: 'Deutsch', linguee: 'german', deeplTarget: 'DE', ponsVerbTables: true,
    subtitleTags: ['de', 'de-DE', 'deu', 'ger'], audioTags: ['deu', 'ger', 'de'],
  },
  pt: {
    code: 'pt', name: 'Portuguese', nativeName: 'Português', linguee: 'portuguese', deeplTarget: 'PT-BR', ponsVerbTables: false,
    subtitleTags: ['pt-BR', 'pt', 'pt-PT', 'por'], audioTags: ['por', 'pt'],
  },
};

export const ENGLISH_SUBTITLE_TAGS = ['en', 'en-US', 'en-GB', 'eng'];
