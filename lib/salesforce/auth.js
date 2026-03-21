// lib/salesforce/auth.js
import jsforce from "jsforce";

/**
 * Create and authenticate a jsforce connection.
 *
 * @param {object} opts
 * @param {string} opts.loginUrl - Salesforce login URL
 * @param {string} opts.username
 * @param {string} opts.password
 * @returns {Promise<jsforce.Connection>}
 */
export const getConnection = async ({ loginUrl, username, password }) => {
  const conn = new jsforce.Connection({ loginUrl });
  await conn.login(username, password);
  return conn;
};
