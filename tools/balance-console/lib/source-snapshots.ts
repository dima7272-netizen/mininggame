import { seedConfigText } from './generated/seed-configs';
import type { ConfigTextMap } from './config-model';

export const githubSnapshot: ConfigTextMap = { ...seedConfigText };

// Сохранённый JSON-предпросмотр из Google Sheets после последнего отмеченного
// импорта PROD. Это наблюдаемый источник, а не подтверждение ответа Roblox API.
export const spreadsheetPreviewSnapshot: ConfigTextMap = {
  ...seedConfigText,
  Spiders: `{
  "visualScale": 2.55,
  "baseSpeedStudsPerSecond": 9,
  "speedPerRoom": 0.32,
  "maximumSpeedStudsPerSecond": 20,
  "attackRadiusStuds": 4.5,
  "attackWindupSeconds": 0.38,
  "attackRecoverySeconds": 0.9,
  "stateSendIntervalSeconds": 0.1
}
`,
};

export const sourceMetadata = {
  github: {
    label: 'GitHub main',
    verified: true,
    detail: 'Локальный снимок HEAD репозитория.',
  },
  spreadsheetPreview: {
    label: 'Предпросмотр Google Sheets',
    verified: false,
    detail: 'Последний сохранённый JSON-предпросмотр; Roblox API повторно не читался.',
  },
} as const;
