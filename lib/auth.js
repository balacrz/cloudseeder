import jsforce from "jsforce";
import dotenv from "dotenv";
dotenv.config();

export const getConnection = async () => {
  console.log(process.env.SF_LOGIN_URL);
  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL
  });

  await conn.login(process.env.SF_USERNAME, process.env.SF_PASSWORD);
  return conn;
};
