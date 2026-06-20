import { Bot, webhookCallback } from "grammy";
import { createClient } from "@supabase/supabase-js";

// 1. 初始化工具
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

// 輔助函式：從 @username 尋找或建立資料庫使用者
async function getOrCreateUserByUsername(username: string) {
  const { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("binding_code", username)
    .single();

  if (user) return user;

  const { data: newUser } = await supabase
    .from("users")
    .insert({ name: username, binding_code: username, role: "staff" })
    .select()
    .single();

  return newUser;
}

// 核心功能：抽取出來的統一派工邏輯（支援純文字或帶圖片派工，並防呆免打 @）
async function handleNewTask(ctx: any, fullText: string) {
  // 🌟 修正後的正規表達式：讓 @ 變成選填 (?:@)?
  const mentionMatch = fullText.match(/\/(?:new|new@\w+)\s+(.*)\s+(?:@)?(\w+)/);
  if (!mentionMatch) {
    return ctx.reply("❌ 格式錯誤！使用範例：\n`/new 維修冷氣 @summerliu` 或 `/new 維修冷氣 summerliu`", { parse_mode: "Markdown" });
  }

  const taskTitle = mentionMatch[1].trim();
  const username = mentionMatch[2].trim(); // 這裡拿到的就是乾淨的 "Chhunheng"

  const staffUser = await getOrCreateUserByUsername(username);
  if (!staffUser) return ctx.reply("❌ 系統初始化員工資料失敗。");

  // 建立任務，狀態設為 active
  const { data: task, error } = await supabase
    .from("tasks")
    .insert({
      title: taskTitle,
      assignee_id: staffUser.id,
      status: "active",
    })
    .select()
    .single();

  if (error || !task) {
    return ctx.reply(`❌ 任務建立失敗：${error?.message}`);
  }

  // 通知群組時，我們主動幫他加上 @，這樣在 Telegram 裡才能真正標記到那個人
  await ctx.reply(
    `📌 *【新任務派發】*\n\n` +
    `📝 任務：${taskTitle}\n` +
    `👤 負責人：@${username}\n\n` +
    `⚡️ 任務已自動生效。請 @${username} 完成任務後，*「回覆」此訊息並上傳完工照片*！`,
    { parse_mode: "Markdown" }
  );
}

// 2-A. 監聽純文字派工 `/new [任務] @群組人`
bot.command("new", async (ctx) => {
  try {
    const text = ctx.match?.trim();
    if (!text) {
      return ctx.reply("❌ 格式錯誤！使用範例：`/new 維修A棟冷氣 @xiaoming`", { parse_mode: "Markdown" });
    }
    // 補回開頭的指令文字組成 fullText 丟給統一處理器
    await handleNewTask(ctx, `/new ${text}`);
  } catch (err: any) {
    await ctx.reply(`💥 派工發生錯誤：${err.message}`);
  }
});

// 2-B. 監聽帶照片的訊息（如果是主管發照片開任務，或者員工回報完工）
bot.on("message:photo", async (ctx) => {
  try {
    const caption = ctx.message.caption?.trim();
    const replyToMessage = ctx.message.reply_to_message;

    // ✨ 新功能：如果主管是發一張照片，並在照片說明寫了 `/new ...`
    if (caption && (caption.startsWith("/new ") || caption.startsWith("/new@"))) {
      await handleNewTask(ctx, caption);
      return; // 處理完發照片派工後直接結束，不往下走員工回報
    }

    // 3. 員工回報完工邏輯：必須是長按回覆 Bot 訊息上傳照片
    if (!replyToMessage || !replyToMessage.text) return;

    // 從員工回覆的那則任務小卡中，精準抓出「任務名稱」
    const taskMatch = replyToMessage.text.match(/📝 任務：(.*)\n/);
    if (!taskMatch) return;
    const taskTitle = taskMatch[1].trim();

    // 更新任務狀態為 completed (待審核)
    await supabase
      .from("tasks")
      .update({ status: "completed" })
      .eq("title", taskTitle)
      .neq("status", "closed");

    // 發出完工審核通知
    await ctx.reply(
      `📸 *【員工完工回報】*\n\n` +
      `📝 待審核任務：${taskTitle}\n` +
      `請主管確認現場照片。若審核通過，請*「回覆」此條通知*並輸入 \`/ok\` 結案。`, 
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    console.error("處理照片區塊失敗:", err);
  }
});

// 4. 監聽 /ok (主管直接回覆 Bot 的完工通知訊息，打 /ok 即可結案)
bot.command("ok", async (ctx) => {
  try {
    const replyToMessage = ctx.message.reply_to_message;
    
    // Fallback 防呆：如果主管忘記按回覆，直接盲撈最新一筆待審核任務
    if (!replyToMessage || !replyToMessage.text) {
      const { data: fallbackTask } = await supabase
        .from("tasks")
        .update({ status: "closed" })
        .eq("status", "completed")
        .order("id", { ascending: false })
        .limit(1)
        .select()
        .maybeSingle();

      if (fallbackTask) {
        return ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${fallbackTask.title}*」已由主管審核通過，順利結案！`);
      }
      return ctx.reply("❌ 請長按「回覆」Bot 發出的那條「📸 【員工完工回報】」通知，再輸入 `/ok`。");
    }

    // 核心黑科技：直接從被回覆的 Bot 通知文字中解構出任務名稱！
    const taskMatch = replyToMessage.text.match(/📝 待審核任務：(.*)\n/);
    if (!taskMatch) {
      return ctx.reply("❌ 無法識別該任務，請確保您回覆的是帶有「待審核任務：xxx」字樣的 Bot 通知。");
    }
    const taskTitle = taskMatch[1].trim();

    // 將該任務狀態在 Supabase 中強制修改為 closed (已結案)
    const { data: task, error } = await supabase
      .from("tasks")
      .update({ status: "closed" })
      .eq("title", taskTitle)
      .neq("status", "closed")
      .select()
      .limit(1)
      .maybeSingle();

    if (error || !task) {
      // 雙重防呆 retry
      const { data: retryTask } = await supabase
        .from("tasks")
        .select("*")
        .eq("title", taskTitle)
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();
        
      if (retryTask) {
        await supabase.from("tasks").update({ status: "closed" }).eq("id", retryTask.id);
        return ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${taskTitle}*」已強制結案！`);
      }
      return ctx.reply(`❌ 結案失敗，在資料庫中找不到名為「${taskTitle}」的任務。`);
    }

    // 在群組內公開宣告結案成功！
    await ctx.reply(`🎉 *【任務審核通過・正式結案】*\n\n✅ 任務「*${task.title}*」已由主管審核通過，順利結案！大家辛苦了！`, {
      parse_mode: "Markdown"
    });
  } catch (err: any) {
    await ctx.reply(`💥 結案發生錯誤：${err.message}`);
  }
});

// 5. 將 grammY 轉換成 Next.js App Router 的 POST 處理器
export const POST = webhookCallback(bot, "std/http");