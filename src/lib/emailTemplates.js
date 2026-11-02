function invoiceCreatedTemplate({
  name,
  month,
  due_date,
  total_amount,
  room_number,
}) {
  const formatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  });

  return {
    subject: `[Coasther] Tagihan Bulan ${month} - Kamar ${room_number}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <div style="background: #7B1113; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #C6A971; margin: 0; font-size: 24px;">Coasther</h1>
          <p style="color: #fff; margin: 4px 0 0;">Small Cost, Big Comfort</p>
        </div>
        <div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Halo <b>${name}</b>,</p>
          <p>Tagihan sewa bulanan kamu sudah tersedia. Berikut ringkasannya:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Kamar</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>Kamar ${room_number}</b></td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Periode</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>${month}</b></td>
            </tr>
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Jatuh Tempo</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>${due_date}</b></td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Total Tagihan</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0; color: #7B1113;">
                <b>${formatter.format(Number(total_amount))}</b>
              </td>
            </tr>
          </table>
          <p style="color: #e53935;">⚠️ Harap bayar sebelum jatuh tempo untuk menghindari denda keterlambatan.</p>
          <p>Silakan buka aplikasi Coasther untuk melakukan pembayaran.</p>
          <br/>
          <p style="color: #999; font-size: 12px;">Email ini dikirim otomatis oleh sistem Coasther. Jangan balas email ini.</p>
        </div>
      </div>
    `,
  };
}

function invoiceOverdueTemplate({
  name,
  month,
  due_date,
  total_amount,
  fine_amount,
  room_number,
}) {
  const formatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  });

  return {
    subject: `[Coasther] ⚠️ Tagihan Terlambat - Kamar ${room_number} Bulan ${month}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <div style="background: #7B1113; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #C6A971; margin: 0; font-size: 24px;">Coasther</h1>
          <p style="color: #fff; margin: 4px 0 0;">Small Cost, Big Comfort</p>
        </div>
        <div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <p>Halo <b>${name}</b>,</p>
          <p style="color: #e53935;"><b>Tagihan kamu sudah melewati jatuh tempo dan dikenakan denda keterlambatan.</b></p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Kamar</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>Kamar ${room_number}</b></td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Periode</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>${month}</b></td>
            </tr>
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Jatuh Tempo</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0; color: #e53935;"><b>${due_date}</b></td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Denda Keterlambatan</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0; color: #e53935;">
                <b>+ ${formatter.format(Number(fine_amount))}</b>
              </td>
            </tr>
            <tr style="background: #fff3f3;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>Total Sekarang</b></td>
              <td style="padding: 10px; border: 1px solid #e0e0e0; color: #7B1113;">
                <b>${formatter.format(Number(total_amount))}</b>
              </td>
            </tr>
          </table>
          <p>Segera lakukan pembayaran melalui aplikasi Coasther untuk menghindari tindakan lebih lanjut.</p>
          <br/>
          <p style="color: #999; font-size: 12px;">Email ini dikirim otomatis oleh sistem Coasther. Jangan balas email ini.</p>
        </div>
      </div>
    `,
  };
}

function paymentSuccessTemplate({
  name,
  month,
  room_number,
  amount,
  paid_at,
  order_id,
}) {
  const formatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    minimumFractionDigits: 0,
  });

  const paidDate = new Date(paid_at).toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return {
    subject: `[Coasther] ✅ Pembayaran Berhasil - Kamar ${room_number} Bulan ${month}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; line-height: 1.6;">
        <div style="background: #7B1113; padding: 24px; border-radius: 8px 8px 0 0;">
          <h1 style="color: #C6A971; margin: 0; font-size: 24px;">Coasther</h1>
          <p style="color: #fff; margin: 4px 0 0;">Small Cost, Big Comfort</p>
        </div>
        <div style="border: 1px solid #e0e0e0; border-top: none; padding: 24px; border-radius: 0 0 8px 8px;">
          <div style="text-align: center; padding: 16px 0;">
            <div style="font-size: 48px;">✅</div>
            <h2 style="color: #1F8A4C; margin: 8px 0;">Pembayaran Berhasil!</h2>
          </div>
          <p>Halo <b>${name}</b>,</p>
          <p>Pembayaran sewa kamu telah berhasil dikonfirmasi. Berikut detailnya:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Kamar</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>Kamar ${room_number}</b></td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Periode</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>${month}</b></td>
            </tr>
            <tr style="background: #f5f5f5;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;">No. Order</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">${order_id}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">Waktu Bayar</td>
              <td style="padding: 10px; border: 1px solid #e0e0e0;">${paidDate}</td>
            </tr>
            <tr style="background: #f0fff4;">
              <td style="padding: 10px; border: 1px solid #e0e0e0;"><b>Total Dibayar</b></td>
              <td style="padding: 10px; border: 1px solid #e0e0e0; color: #1F8A4C;">
                <b>${formatter.format(Number(amount))}</b>
              </td>
            </tr>
          </table>
          <p>Terima kasih telah membayar tepat waktu! 🎉</p>
          <br/>
          <p style="color: #999; font-size: 12px;">Email ini dikirim otomatis oleh sistem Coasther. Jangan balas email ini.</p>
        </div>
      </div>
    `,
  };
}

module.exports = {
  invoiceCreatedTemplate,
  invoiceOverdueTemplate,
  paymentSuccessTemplate,
};
