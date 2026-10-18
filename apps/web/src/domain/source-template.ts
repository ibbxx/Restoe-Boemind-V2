// Generated from immutable AHAS Sistem.xlsx; all source formulas, including audit-only formulas, remain here.
export const SOURCE_HASH = "efe4f10792453d8407bb47539b7f7aea015332faf6cabdbeb22a530a9e5e1abc";
export const SOURCE_SHEETS: readonly { name: string; cells: Readonly<Record<string, { text?: string; number?: string; formula?: string }>>; merges: readonly string[] }[] = [
  {
    "name": "AHAS INU",
    "cells": {
      "B3": {
        "text": "EVALUASI HARGA VENDOR"
      },
      "G3": {
        "text": "ANALISIS HARGA SATUAN (AHS)"
      },
      "G4": {
        "text": "Tgl Analisis (RnD)"
      },
      "H4": {
        "number": "46225.0"
      },
      "J4": {
        "text": "Sumber"
      },
      "K4": {
        "formula": "C9"
      },
      "B5": {
        "text": "Pekerjaan / Material             :"
      },
      "D5": {
        "text": "HSD"
      },
      "G5": {
        "text": "Marketing"
      },
      "J5": {
        "text": "Lokasi"
      },
      "K5": {
        "formula": "C26"
      },
      "B6": {
        "text": "Customer                              :"
      },
      "D6": {
        "text": "PT Tonasa"
      },
      "G6": {
        "text": "Pembayaran"
      },
      "H6": {
        "text": "30 Hari"
      },
      "J6": {
        "text": "Dokumen"
      },
      "K6": {
        "formula": "C18"
      },
      "B7": {
        "text": "Lokasi                                   :"
      },
      "D7": {
        "text": "Samarinda"
      },
      "G7": {
        "text": "Harga Keekonomian"
      },
      "H7": {
        "number": "22450.0"
      },
      "J7": {
        "text": "Diskon"
      },
      "G8": {
        "text": "HARGA INCLUDE"
      },
      "J8": {
        "formula": "sum(I11:I13)"
      },
      "B9": {
        "text": "Uraian"
      },
      "C9": {
        "text": "PT Jagad"
      },
      "D9": {
        "text": "AKR"
      },
      "E9": {
        "text": "PT Petrocon"
      },
      "G9": {
        "text": "TOTAL PENDAPATAN"
      },
      "L9": {
        "formula": "L10*J11"
      },
      "B10": {
        "text": "Harga Dasar"
      },
      "C10": {
        "formula": "19900"
      },
      "D10": {
        "number": "20000.0"
      },
      "E10": {
        "number": "0.0"
      },
      "G10": {
        "text": "HARGA JUAL SETELAH PAJAK"
      },
      "L10": {
        "formula": "SUM(I11:I13)"
      },
      "B11": {
        "text": "PPN"
      },
      "C11": {
        "formula": "C10*11%"
      },
      "D11": {
        "formula": "D10*11%"
      },
      "E11": {
        "formula": "E10*11%"
      },
      "G11": {
        "text": "HARGA JUAL"
      },
      "H11": {
        "text": "Harga Dasar"
      },
      "I11": {
        "formula": "25900/1.11"
      },
      "J11": {
        "number": "50000.0"
      },
      "K11": {
        "formula": "I11*J11"
      },
      "B12": {
        "text": "PBBKB"
      },
      "C12": {
        "number": "0.0"
      },
      "D12": {
        "formula": "D10*7.5%"
      },
      "E12": {
        "number": "0.0"
      },
      "H12": {
        "text": "PBBKB"
      },
      "I12": {
        "formula": "I11*7.5%*0"
      },
      "J12": {
        "formula": "J11"
      },
      "K12": {
        "formula": "I12*J12"
      },
      "B13": {
        "text": "PPH"
      },
      "C13": {
        "number": "0.0"
      },
      "D13": {
        "formula": "D10*0.3%"
      },
      "E13": {
        "number": "0.0"
      },
      "H13": {
        "text": "PPN 11%"
      },
      "I13": {
        "formula": "I11*11%"
      },
      "J13": {
        "formula": "J12"
      },
      "K13": {
        "formula": "I13*J13"
      },
      "B14": {
        "text": "OAT"
      },
      "C14": {
        "number": "0.0"
      },
      "D14": {
        "number": "200.0"
      },
      "G14": {
        "text": "TOTAL BIAYA"
      },
      "L14": {
        "formula": "sum(K16:K33)"
      },
      "B15": {
        "text": "PPN OAT"
      },
      "C15": {
        "formula": "C14*11%"
      },
      "D15": {
        "formula": "D14*11%"
      },
      "G15": {
        "text": "BIAYA PERLITER"
      },
      "L15": {
        "formula": "sum(I16:I33)"
      },
      "B16": {
        "text": "BPH"
      },
      "C16": {
        "number": "0.0"
      },
      "G16": {
        "text": "HPP"
      },
      "H16": {
        "text": "Harga Dasar"
      },
      "I16": {
        "formula": "D30"
      },
      "J16": {
        "formula": "J11"
      },
      "K16": {
        "formula": "I16*J16"
      },
      "C17": {
        "formula": "sum(C10:C16)"
      },
      "D17": {
        "formula": "sum(D10:D15)"
      },
      "E17": {
        "formula": "SUM(E10:E16)"
      },
      "H17": {
        "text": "OAT"
      },
      "I17": {
        "formula": "I15*7.5%*0"
      },
      "J17": {
        "formula": "J16"
      },
      "K17": {
        "formula": "I17*J17"
      },
      "B18": {
        "text": "Note :"
      },
      "H18": {
        "text": "PBBKB"
      },
      "I18": {
        "formula": "I16*7.5%*0"
      },
      "J18": {
        "formula": "J17"
      },
      "K18": {
        "formula": "I18*J18"
      },
      "H19": {
        "text": "PPH INU 0,3%"
      },
      "I19": {
        "number": "0.0"
      },
      "J19": {
        "formula": "J18"
      },
      "K19": {
        "formula": "I19*J19"
      },
      "H20": {
        "text": "BPH Migas 0,25%"
      },
      "I20": {
        "number": "0.0"
      },
      "J20": {
        "formula": "J19"
      },
      "K20": {
        "formula": "I20*J20"
      },
      "G21": {
        "text": "PAJAK"
      },
      "H21": {
        "text": "PPN 11%"
      },
      "I21": {
        "formula": "I16*11%"
      },
      "J21": {
        "formula": "J20"
      },
      "K21": {
        "formula": "I21*J21"
      },
      "H22": {
        "text": "PPH penjualan BUMN 1,5%"
      },
      "I22": {
        "number": "0.0"
      },
      "J22": {
        "formula": "J21"
      },
      "K22": {
        "formula": "I22*J22"
      },
      "B23": {
        "text": "Konversi Satuan INU"
      },
      "G23": {
        "text": "COST OF FUND"
      },
      "H23": {
        "text": "Investor"
      },
      "I23": {
        "number": "0.0"
      },
      "J23": {
        "formula": "J22"
      },
      "K23": {
        "formula": "I23*J23"
      },
      "H24": {
        "text": "Bunga Bank"
      },
      "I24": {
        "number": "0.0"
      },
      "J24": {
        "formula": "J23"
      },
      "K24": {
        "formula": "I24*J24"
      },
      "B25": {
        "text": "Periode 15 - 31 Oktober 2026"
      },
      "H25": {
        "text": "Diskonto SKBDN 3,3%"
      },
      "I25": {
        "number": "0.0"
      },
      "J25": {
        "formula": "J24"
      },
      "K25": {
        "formula": "I25*J25"
      },
      "B26": {
        "text": "Lokasi            :"
      },
      "C26": {
        "text": "Samarinda"
      },
      "G26": {
        "text": "OPERASIONAL"
      },
      "H26": {
        "text": "Biaya Operasional"
      },
      "I26": {
        "number": "0.0"
      },
      "J26": {
        "formula": "J25"
      },
      "K26": {
        "formula": "I26*J26"
      },
      "B27": {
        "text": "Nama INU     :"
      },
      "C27": {
        "formula": "D9"
      },
      "H27": {
        "text": "Bonus Marketing"
      },
      "I27": {
        "number": "50.0"
      },
      "J27": {
        "formula": "J26"
      },
      "K27": {
        "formula": "I27*J27"
      },
      "G28": {
        "text": "ASET"
      },
      "H28": {
        "text": "Tangki Solar"
      },
      "I28": {
        "number": "0.0"
      },
      "J28": {
        "formula": "J27"
      },
      "K28": {
        "formula": "I28*J28"
      },
      "B29": {
        "text": "Uraian"
      },
      "C29": {
        "text": "Harga INU"
      },
      "D29": {
        "text": "Biaya"
      },
      "G29": {
        "text": "KOORDINASI"
      },
      "H29": {
        "text": "Ormas/Lainnya"
      },
      "I29": {
        "number": "0.0"
      },
      "J29": {
        "formula": "J28"
      },
      "K29": {
        "formula": "I29*J29"
      },
      "B30": {
        "text": "Harga Dasar"
      },
      "C30": {
        "formula": "D10"
      },
      "D30": {
        "number": "21880.0"
      },
      "G30": {
        "text": "RELASI"
      },
      "H30": {
        "text": "Biaya Proyek"
      },
      "I30": {
        "number": "200.0"
      },
      "J30": {
        "formula": "J29"
      },
      "K30": {
        "formula": "I30*J30"
      },
      "B31": {
        "text": "PPN"
      },
      "C31": {
        "formula": "C30*11%"
      },
      "D31": {
        "formula": "D30*11%"
      },
      "H31": {
        "text": "Biaya  Mediator "
      },
      "I31": {
        "number": "250.0"
      },
      "J31": {
        "formula": "J30"
      },
      "K31": {
        "formula": "I31*J31"
      },
      "B32": {
        "text": "PBBKB"
      },
      "C32": {
        "formula": "C30*7.5%"
      },
      "G32": {
        "text": "RESIKO"
      },
      "H32": {
        "text": "Biaya Resiko"
      },
      "I32": {
        "number": "0.0"
      },
      "J32": {
        "formula": "J31"
      },
      "K32": {
        "formula": "I32*J32"
      },
      "B33": {
        "text": "PPH"
      },
      "C33": {
        "formula": "C30*0.3%"
      },
      "H33": {
        "text": "Kenaikan Harga"
      },
      "I33": {
        "number": "0.0"
      },
      "J33": {
        "formula": "J32"
      },
      "K33": {
        "formula": "I33*J33"
      },
      "B34": {
        "text": "OAT"
      },
      "C34": {
        "number": "200.0"
      },
      "G34": {
        "text": "LABA KOTOR"
      },
      "L34": {
        "formula": "L9-L14"
      },
      "B35": {
        "text": "PPN"
      },
      "C35": {
        "formula": "C34*11%"
      },
      "G35": {
        "text": "SELISIH PPN"
      },
      "L35": {
        "formula": "K13-K21"
      },
      "B36": {
        "text": "ALL IN"
      },
      "C36": {
        "formula": "SUM(C30:C35)"
      },
      "D36": {
        "formula": "SUM(D30:D35)"
      },
      "G36": {
        "text": "LABA BERSIH"
      },
      "L36": {
        "formula": "L34-L35"
      },
      "G37": {
        "text": "LABA BERSIH PERLITER"
      },
      "L37": {
        "formula": "L36/J11"
      },
      "B38": {
        "text": "Gross Profit"
      },
      "C38": {
        "formula": "D30-C30-C32-C33-C34"
      },
      "G38": {
        "text": "PERSENTASE"
      },
      "L38": {
        "formula": "L36/L14"
      },
      "B39": {
        "text": "BPH Migas"
      },
      "C39": {
        "formula": "D30*0.25%"
      },
      "G39": {
        "text": "Notes"
      },
      "B40": {
        "text": "Net Margin"
      },
      "C40": {
        "formula": "C38-C39"
      },
      "B41": {
        "text": "PPH"
      },
      "C41": {
        "formula": "C40*22%"
      },
      "B42": {
        "text": "Profit MUE"
      },
      "C42": {
        "formula": "C40-C41"
      },
      "D42": {
        "text": "Crosscheck"
      }
    },
    "merges": [
      "K4:L4",
      "K5:L5",
      "K6:L6",
      "K7:L7",
      "J8:L8",
      "B3:E3",
      "G3:L3",
      "B4:E4",
      "H4:I4",
      "B5:C5",
      "D5:E5",
      "H5:I5",
      "B6:C6",
      "D6:E6",
      "H6:I6",
      "B7:C7",
      "D7:E7",
      "H7:I7",
      "G8:I8",
      "C18:C21",
      "D18:D21",
      "B23:D24",
      "B25:D25",
      "C26:D26",
      "C27:D27",
      "B28:D28",
      "G9:K9",
      "G10:K10",
      "G11:G13",
      "G14:K14",
      "G15:K15",
      "B18:B21",
      "E18:E21",
      "G35:K35",
      "G36:K36",
      "G37:K37",
      "G38:K38",
      "G39:L39",
      "G40:L40",
      "G41:L41",
      "G42:L42",
      "G16:G20",
      "G21:G22",
      "G23:G25",
      "G26:G27",
      "G30:G31",
      "G32:G33",
      "G34:K34"
    ]
  },
  {
    "name": "AHAS Solar bawah",
    "cells": {
      "B2": {
        "text": "EVALUASI HARGA VENDOR"
      },
      "G2": {
        "text": "ANALISIS HARGA SATUAN (AHS)"
      },
      "G3": {
        "text": "Tgl Analisis (RnD)"
      },
      "H3": {
        "number": "46225.0"
      },
      "J3": {
        "text": "Sumber"
      },
      "K3": {
        "formula": "C8"
      },
      "B4": {
        "text": "Pekerjaan / Material             :"
      },
      "D4": {
        "text": "HSD"
      },
      "G4": {
        "text": "Marketing"
      },
      "J4": {
        "text": "Lokasi"
      },
      "K4": {
        "formula": "C25"
      },
      "B5": {
        "text": "Customer                              :"
      },
      "D5": {
        "text": "PT Tonasa"
      },
      "G5": {
        "text": "Pembayaran"
      },
      "H5": {
        "text": "30 Hari"
      },
      "J5": {
        "text": "Dokumen"
      },
      "K5": {
        "formula": "C17"
      },
      "B6": {
        "text": "Lokasi                                   :"
      },
      "D6": {
        "text": "Samarinda"
      },
      "G6": {
        "text": "Harga Keekonomian"
      },
      "H6": {
        "number": "22450.0"
      },
      "J6": {
        "text": "Diskon"
      },
      "G7": {
        "text": "HARGA INCLUDE"
      },
      "J7": {
        "formula": "sum(I10:I12)"
      },
      "B8": {
        "text": "Uraian"
      },
      "C8": {
        "text": "Aman 88"
      },
      "D8": {
        "text": "Katana"
      },
      "E8": {
        "text": "Jangkar "
      },
      "G8": {
        "text": "TOTAL PENDAPATAN"
      },
      "L8": {
        "formula": "L9*J10"
      },
      "B9": {
        "text": "Harga Dasar"
      },
      "C9": {
        "number": "18000.0"
      },
      "D9": {
        "number": "18500.0"
      },
      "E9": {
        "number": "0.0"
      },
      "G9": {
        "text": "HARGA JUAL SETELAH PAJAK"
      },
      "L9": {
        "formula": "SUM(I10:I12)"
      },
      "B10": {
        "text": "PPN"
      },
      "C10": {
        "formula": "C9*11%"
      },
      "D10": {
        "formula": "D9*11%"
      },
      "E10": {
        "formula": "E9*11%"
      },
      "G10": {
        "text": "HARGA JUAL"
      },
      "H10": {
        "text": "Harga Dasar"
      },
      "I10": {
        "formula": "25900/1.11"
      },
      "J10": {
        "number": "50000.0"
      },
      "K10": {
        "formula": "I10*J10"
      },
      "B11": {
        "text": "PBBKB"
      },
      "C11": {
        "number": "0.0"
      },
      "D11": {
        "number": "0.0"
      },
      "E11": {
        "number": "0.0"
      },
      "H11": {
        "text": "PBBKB"
      },
      "I11": {
        "formula": "I10*7.5%*0"
      },
      "J11": {
        "formula": "J10"
      },
      "K11": {
        "formula": "I11*J11"
      },
      "B12": {
        "text": "PPH"
      },
      "C12": {
        "number": "0.0"
      },
      "D12": {
        "number": "0.0"
      },
      "E12": {
        "number": "0.0"
      },
      "H12": {
        "text": "PPN 11%"
      },
      "I12": {
        "formula": "I10*11%"
      },
      "J12": {
        "formula": "J11"
      },
      "K12": {
        "formula": "I12*J12"
      },
      "B13": {
        "text": "OAT"
      },
      "C13": {
        "number": "0.0"
      },
      "D13": {
        "number": "0.0"
      },
      "G13": {
        "text": "TOTAL BIAYA"
      },
      "L13": {
        "formula": "sum(K15:K32)"
      },
      "B14": {
        "text": "PPN OAT"
      },
      "C14": {
        "formula": "C13*11%"
      },
      "D14": {
        "formula": "D13*11%"
      },
      "G14": {
        "text": "BIAYA PERLITER"
      },
      "L14": {
        "formula": "sum(I15:I32)"
      },
      "B15": {
        "text": "BPH"
      },
      "C15": {
        "number": "0.0"
      },
      "G15": {
        "text": "HPP"
      },
      "H15": {
        "text": "Harga Dasar"
      },
      "I15": {
        "formula": "D29"
      },
      "J15": {
        "formula": "J10"
      },
      "K15": {
        "formula": "I15*J15"
      },
      "C16": {
        "formula": "sum(C9:C15)"
      },
      "D16": {
        "formula": "sum(D9:D14)"
      },
      "E16": {
        "formula": "SUM(E9:E15)"
      },
      "H16": {
        "text": "OAT"
      },
      "I16": {
        "formula": "I14*7.5%*0"
      },
      "J16": {
        "formula": "J15"
      },
      "K16": {
        "formula": "I16*J16"
      },
      "B17": {
        "text": "Note :"
      },
      "H17": {
        "text": "PBBKB"
      },
      "I17": {
        "formula": "I15*7.5%*0"
      },
      "J17": {
        "formula": "J16"
      },
      "K17": {
        "formula": "I17*J17"
      },
      "H18": {
        "text": "PPH INU 0,3%"
      },
      "I18": {
        "number": "0.0"
      },
      "J18": {
        "formula": "J17"
      },
      "K18": {
        "formula": "I18*J18"
      },
      "H19": {
        "text": "BPH Migas 0,25%"
      },
      "I19": {
        "number": "0.0"
      },
      "J19": {
        "formula": "J18"
      },
      "K19": {
        "formula": "I19*J19"
      },
      "G20": {
        "text": "PAJAK"
      },
      "H20": {
        "text": "PPN 11%"
      },
      "I20": {
        "formula": "I15*11%"
      },
      "J20": {
        "formula": "J19"
      },
      "K20": {
        "formula": "I20*J20"
      },
      "H21": {
        "text": "PPH penjualan BUMN 1,5%"
      },
      "I21": {
        "number": "0.0"
      },
      "J21": {
        "formula": "J20"
      },
      "K21": {
        "formula": "I21*J21"
      },
      "B22": {
        "text": "Konversi Satuan INU"
      },
      "G22": {
        "text": "COST OF FUND"
      },
      "H22": {
        "text": "Investor"
      },
      "I22": {
        "number": "0.0"
      },
      "J22": {
        "formula": "J21"
      },
      "K22": {
        "formula": "I22*J22"
      },
      "H23": {
        "text": "Bunga Bank"
      },
      "I23": {
        "number": "0.0"
      },
      "J23": {
        "formula": "J22"
      },
      "K23": {
        "formula": "I23*J23"
      },
      "B24": {
        "text": "Periode 15 - 31 Oktober 2026"
      },
      "H24": {
        "text": "Diskonto SKBDN 3,3%"
      },
      "I24": {
        "number": "0.0"
      },
      "J24": {
        "formula": "J23"
      },
      "K24": {
        "formula": "I24*J24"
      },
      "B25": {
        "text": "Lokasi            :"
      },
      "C25": {
        "text": "Samarinda"
      },
      "G25": {
        "text": "OPERASIONAL"
      },
      "H25": {
        "text": "Biaya Operasional"
      },
      "I25": {
        "number": "0.0"
      },
      "J25": {
        "formula": "J24"
      },
      "K25": {
        "formula": "I25*J25"
      },
      "B26": {
        "text": "Nama INU     :"
      },
      "C26": {
        "formula": "D8"
      },
      "H26": {
        "text": "Bonus Marketing"
      },
      "I26": {
        "number": "50.0"
      },
      "J26": {
        "formula": "J25"
      },
      "K26": {
        "formula": "I26*J26"
      },
      "G27": {
        "text": "ASET"
      },
      "H27": {
        "text": "Tangki Solar"
      },
      "I27": {
        "number": "0.0"
      },
      "J27": {
        "formula": "J26"
      },
      "K27": {
        "formula": "I27*J27"
      },
      "B28": {
        "text": "Uraian"
      },
      "C28": {
        "text": "Harga INU"
      },
      "D28": {
        "text": "Biaya"
      },
      "G28": {
        "text": "KOORDINASI"
      },
      "H28": {
        "text": "Ormas/Lainnya"
      },
      "I28": {
        "number": "0.0"
      },
      "J28": {
        "formula": "J27"
      },
      "K28": {
        "formula": "I28*J28"
      },
      "B29": {
        "text": "Harga Dasar"
      },
      "C29": {
        "formula": "18000"
      },
      "D29": {
        "formula": "C29"
      },
      "G29": {
        "text": "RELASI"
      },
      "H29": {
        "text": "Biaya Proyek"
      },
      "I29": {
        "number": "200.0"
      },
      "J29": {
        "formula": "J28"
      },
      "K29": {
        "formula": "I29*J29"
      },
      "B30": {
        "text": "PPN"
      },
      "C30": {
        "formula": "C29*11%"
      },
      "D30": {
        "formula": "D29*11%"
      },
      "H30": {
        "text": "Biaya  Mediator "
      },
      "I30": {
        "number": "250.0"
      },
      "J30": {
        "formula": "J29"
      },
      "K30": {
        "formula": "I30*J30"
      },
      "B31": {
        "text": "PBBKB"
      },
      "C31": {
        "number": "0.0"
      },
      "G31": {
        "text": "RESIKO"
      },
      "H31": {
        "text": "Biaya Keagenan"
      },
      "I31": {
        "number": "100.0"
      },
      "J31": {
        "formula": "J30"
      },
      "K31": {
        "formula": "I31*J31"
      },
      "B32": {
        "text": "PPH"
      },
      "C32": {
        "number": "0.0"
      },
      "H32": {
        "text": "Kenaikan Harga"
      },
      "I32": {
        "number": "0.0"
      },
      "J32": {
        "formula": "J31"
      },
      "K32": {
        "formula": "I32*J32"
      },
      "B33": {
        "text": "OAT"
      },
      "C33": {
        "number": "0.0"
      },
      "G33": {
        "text": "LABA KOTOR"
      },
      "L33": {
        "formula": "L8-L13"
      },
      "B34": {
        "text": "PPN"
      },
      "C34": {
        "number": "0.0"
      },
      "G34": {
        "text": "SELISIH PPN"
      },
      "L34": {
        "formula": "K12-K20"
      },
      "B35": {
        "text": "ALL IN"
      },
      "C35": {
        "formula": "SUM(C29:C34)"
      },
      "D35": {
        "formula": "SUM(D29:D34)"
      },
      "G35": {
        "text": "LABA BERSIH"
      },
      "L35": {
        "formula": "L33-L34"
      },
      "G36": {
        "text": "LABA BERSIH PERLITER"
      },
      "L36": {
        "formula": "L35/J10"
      },
      "B37": {
        "text": "Gross Profit"
      },
      "C37": {
        "formula": "D29-C29-C31-C32-C33"
      },
      "G37": {
        "text": "PERSENTASE"
      },
      "L37": {
        "formula": "L35/L13"
      },
      "B38": {
        "text": "BPH Migas"
      },
      "C38": {
        "number": "0.0"
      },
      "G38": {
        "text": "Notes"
      },
      "B39": {
        "text": "Net Margin"
      },
      "C39": {
        "formula": "C37-C38"
      },
      "B40": {
        "text": "PPH"
      },
      "C40": {
        "formula": "C39*22%"
      },
      "B41": {
        "text": "Profit MUE"
      },
      "C41": {
        "formula": "C39-C40"
      },
      "D41": {
        "text": "Crosscheck"
      }
    },
    "merges": [
      "K3:L3",
      "K4:L4",
      "K5:L5",
      "K6:L6",
      "J7:L7",
      "B2:E2",
      "G2:L2",
      "B3:E3",
      "H3:I3",
      "B4:C4",
      "D4:E4",
      "H4:I4",
      "B5:C5",
      "D5:E5",
      "H5:I5",
      "B6:C6",
      "D6:E6",
      "H6:I6",
      "G7:I7",
      "C17:C20",
      "D17:D20",
      "B22:D23",
      "B24:D24",
      "C25:D25",
      "C26:D26",
      "B27:D27",
      "G8:K8",
      "G9:K9",
      "G10:G12",
      "G13:K13",
      "G14:K14",
      "B17:B20",
      "E17:E20",
      "G34:K34",
      "G35:K35",
      "G36:K36",
      "G37:K37",
      "G38:L38",
      "G39:L39",
      "G40:L40",
      "G41:L41",
      "G15:G19",
      "G20:G21",
      "G22:G24",
      "G25:G26",
      "G29:G30",
      "G31:G32",
      "G33:K33"
    ]
  }
];
