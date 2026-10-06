export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://commerce:commerce@localhost:5433/commercehub',
  port: Number(process.env.PORT ?? 3000),
  reservationMinutes: 15,
};
