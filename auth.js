import { createClient } from '@neon/neon-js';

const authUrl = window.POSTULA_AUTH_URL || '';
const dataApiUrl = window.POSTULA_DATA_API_URL || '';
export const neon = authUrl && dataApiUrl
  ? createClient({ auth: { url: authUrl }, dataApi: { url: dataApiUrl } })
  : null;
