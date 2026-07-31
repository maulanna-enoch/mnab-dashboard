const { getWriteSheetsClient, getSheetGridId } = require('./_lib/sheets');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  try {
    const { rowNumber } = req.body || {};
    if (!rowNumber) {
      res.status(400).json({ error: 'Missing required field: rowNumber' });
      return;
    }

    const sheets = getWriteSheetsClient();
    const sheetId = await getSheetGridId(sheets, process.env.SHEET_ID, 'transactions');

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.SHEET_ID,
      requestBody: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1, // 0-based
              endIndex: rowNumber,
            },
          },
        }],
      },
    });

    res.status(200).json({ ok: true, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
