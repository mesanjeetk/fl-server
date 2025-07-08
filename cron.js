import cron from "cron"
import https from "https"
export const job = new cron.CronJob("*/10 * * * *", async () => {
  https
    .get("https://fl-server-kcrf.onrender.com", (res) => {
      if(res.statusCode === 200) console.log("works")
      else console.log("not wroked")
    })
    .on("error" , (e) => console.log( "Error while sending request",e))
})