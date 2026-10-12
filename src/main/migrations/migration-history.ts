/**
 * Pinned identities for released migrations. DB-07 treats this list as
 * append-only: changing released SQL or journal metadata must fail bundle
 * validation until a deliberate application release appends a new identity.
 */
export interface CanonicalMigrationIdentity {
  idx: number
  version: string
  when: number
  tag: string
  hash: string
}

export const CANONICAL_MIGRATION_HISTORY: readonly CanonicalMigrationIdentity[] = [
  {
    "idx": 0,
    "version": "6",
    "when": 1788489356111,
    "tag": "0000_overconfident_doctor_octopus",
    "hash": "e3486ee7f3085ad8b4227ec9aeb36f885591a5b500b836b41265c2f1aef89fbe"
  },
  {
    "idx": 1,
    "version": "6",
    "when": 1788632761265,
    "tag": "0001_big_lyja",
    "hash": "fae895aaff22f1d03f294b76288342e3c864059fcd73ac640af14385e5f88873"
  },
  {
    "idx": 2,
    "version": "6",
    "when": 1788719000000,
    "tag": "0002_planned_materials",
    "hash": "170321ce96a165fd140d7fca33ee763fc9dd7fad72dc04781896b9cb9b679c5c"
  },
  {
    "idx": 3,
    "version": "6",
    "when": 1788800000000,
    "tag": "0003_generic_materials",
    "hash": "842e9fb4794648143482a904235a446f24fde954cafd89c34742170501fa753e"
  },
  {
    "idx": 4,
    "version": "6",
    "when": 1788886400000,
    "tag": "0004_medical_centennial",
    "hash": "ba88c9650b6bb1f3cf3091131dbf30570bc989b57a5b29e86f2d39428cde1139"
  },
  {
    "idx": 5,
    "version": "6",
    "when": 1788972800000,
    "tag": "0005_salary_payment_children",
    "hash": "7c73cec35712c600dccf6db4a8f2effb6cfb1126f737e9135d2812b4a9f4c68e"
  },
  {
    "idx": 6,
    "version": "6",
    "when": 1789059200000,
    "tag": "0006_planned_machines_worksheet",
    "hash": "8c2e30d387d9d75b06f262fa4b79aba690b5673f5f83d8f5569b6f199903d895"
  },
  {
    "idx": 7,
    "version": "6",
    "when": 1789145600000,
    "tag": "0007_recurring_expenses",
    "hash": "7b9578cd2060647e4e78d471499da420530601f792aa0b8a2620835b01984092"
  },
  {
    "idx": 8,
    "version": "6",
    "when": 1789232000000,
    "tag": "0008_product_machine_commission_lines",
    "hash": "9fc8879ecb0281c25446f6a4f8232b9e5e9d269e9f63d91a2bfea96a2d3bb693"
  },
  {
    "idx": 9,
    "version": "6",
    "when": 1789318400000,
    "tag": "0009_approved_invoice_starts_workflow",
    "hash": "ee95e26644447084b431f927a1fb6891a184266a173783c0363cd4b63617b9cc"
  },
  {
    "idx": 10,
    "version": "6",
    "when": 1789404800000,
    "tag": "0010_final_invoice_terms",
    "hash": "609462ca1df3d51aa14fbae4ac7b8782a7bb0a14fedad94410198443c2a8e530"
  },
  {
    "idx": 11,
    "version": "6",
    "when": 1789491200000,
    "tag": "0011_product_bom_line_price",
    "hash": "35b1653754aa9a5382222ac47407d35e65c128544e6e122c4b9d0cd94bf508bf"
  },
  {
    "idx": 12,
    "version": "6",
    "when": 1789577600000,
    "tag": "0012_users_soft_delete",
    "hash": "e7585a3f5204efcad464cd17209de2faa6e328046e546909c4f38e81e0abc598"
  },
  {
    "idx": 13,
    "version": "6",
    "when": 1789664000000,
    "tag": "0013_users_role_id_nullable",
    "hash": "ae56e25af73768d89e4bb4e27b2de63b25c87b4405540cefe133e09d54fd277f"
  },
  {
    "idx": 14,
    "version": "6",
    "when": 1789750400000,
    "tag": "0014_remember_tokens",
    "hash": "0a87fa7f9971e38c90f6b471c2fd450752e54f450c03f9fd496edd223746ea49"
  },
  {
    "idx": 15,
    "version": "6",
    "when": 1789836800000,
    "tag": "0015_notification_reads",
    "hash": "a27445ef6c7c13e96da2c12b5d0394f969d037e4af801632e5999af6602b0044"
  },
  {
    "idx": 16,
    "version": "6",
    "when": 1789923200000,
    "tag": "0016_user_avatar",
    "hash": "a55c62eaa864464774876fd0e5db285fe4b8f260f0257f82cc9a726cea52fbb3"
  },
  {
    "idx": 17,
    "version": "6",
    "when": 1790009600000,
    "tag": "0017_great_tomorrow_man",
    "hash": "4c39115464f40601ca9f40af35b6f0e5aba02722bb7b3177ba25e6533d00ff3b"
  },
  {
    "idx": 18,
    "version": "6",
    "when": 1790096000000,
    "tag": "0018_special_mastermind",
    "hash": "d0960aaf282a35f54a5d00c04fd889614cee80f19d8ab2f88d9910036ae7709a"
  },
  {
    "idx": 19,
    "version": "6",
    "when": 1790182400000,
    "tag": "0019_invoice_charges_print_visibility",
    "hash": "305ca020be834177f60d4b1f01f314570409a50e7367d4279df6316f17dbd122"
  },
  {
    "idx": 20,
    "version": "6",
    "when": 1790268800000,
    "tag": "0020_sweet_carnage",
    "hash": "675644593399dd59f6d9a3dc140e7f2aac4b4377d4327b09163122547836a498"
  },
  {
    "idx": 21,
    "version": "6",
    "when": 1790355200000,
    "tag": "0021_condemned_namora",
    "hash": "6b879ab5ba2babc01c86839d74e20b32c179049da994c0a4d1778b8549a7ba29"
  },
  {
    "idx": 22,
    "version": "6",
    "when": 1790441600000,
    "tag": "0022_quick_raza",
    "hash": "4b4b2adc2ebbcdd43c019d71056fcf339f4515d06de1bf4e97e5e9a4ece27c0d"
  },
  {
    "idx": 23,
    "version": "6",
    "when": 1790528000000,
    "tag": "0023_dark_tyrannus",
    "hash": "6c548334abeee5f0cbcebf7b4ab17fb26c363d9a8657b4c804cb238af5d6fb61"
  },
  {
    "idx": 24,
    "version": "6",
    "when": 1790614400000,
    "tag": "0024_fast_madame_web",
    "hash": "a08713a4e972034eacd2d6f87b1d5f2c5730ea7dca7b27ee17e043832f50c221"
  },
  {
    "idx": 25,
    "version": "6",
    "when": 1790700800000,
    "tag": "0025_mushy_fallen_one",
    "hash": "c86119829a235af0b12da5b43ba813f7769da634da3621d844a5ad07d20a3977"
  },
  {
    "idx": 26,
    "version": "6",
    "when": 1790787200000,
    "tag": "0026_smiling_mikhail_rasputin",
    "hash": "447f176d10366af3d6c9b9ec784c15e4b6e51b38e269bde12764c23c500d39e8"
  },
  {
    "idx": 27,
    "version": "6",
    "when": 1790873600000,
    "tag": "0027_noisy_the_order",
    "hash": "4fa5baad0d048ce4e666012628528221878a6ae81f86e531cfe087da810d5065"
  },
  {
    "idx": 28,
    "version": "6",
    "when": 1790960000000,
    "tag": "0028_normalized_rbac",
    "hash": "6b5dedb0cb607468fd5fda2b621a2b39417b6a69db7c1024c0d8922f40e1d330"
  },
  {
    "idx": 29,
    "version": "6",
    "when": 1791046400000,
    "tag": "0029_color_material_reference",
    "hash": "52a49932fac43c29ea42e5c6af822a5799bb573bfb4968de15ebaacbacd3f70c"
  },
  {
    "idx": 30,
    "version": "6",
    "when": 1791132800000,
    "tag": "0030_invoice_item_selections",
    "hash": "ed233f7f75f4c65f3cde61b7775570fa1abc20db9060273282c95741f6212158"
  },
  {
    "idx": 31,
    "version": "6",
    "when": 1791219200000,
    "tag": "0031_material_color_groups",
    "hash": "d1266233e7ee81dabc900dae5efce42965fae511cad5d28b0f321140aeda1e8c"
  },
  {
    "idx": 32,
    "version": "6",
    "when": 1791305600000,
    "tag": "0032_approved_invoice_initial_payment",
    "hash": "46d2999c5c6803db6440b3c7a9c65fe7a69505be11fee13d02769e07ffb232d3"
  },
  {
    "idx": 33,
    "version": "6",
    "when": 1791392000000,
    "tag": "0033_customer_archive_snapshot",
    "hash": "ab423ccbcac8732ad09cd33717c6e4773db44c6d3be33e828324f8ea928a7fc4"
  },
  {
    "idx": 34,
    "version": "6",
    "when": 1791478400000,
    "tag": "0034_payroll_payment_reversal",
    "hash": "357e81bf0e4c01e9a6cf5f282f99fd9c6f9f5ae96a97fc7248b5f1f3db602703"
  },
  {
    "idx": 35,
    "version": "6",
    "when": 1791564800000,
    "tag": "0035_payroll_history_visibility",
    "hash": "59bd65b5fc7f1833f2a44fbd6f35e64c075da90cb38040bd4e1154206a5be996"
  },
  {
    "idx": 36,
    "version": "6",
    "when": 1791651200000,
    "tag": "0036_material_classification_leaf",
    "hash": "fc4b7bc252ced7928d08acf6db8e1751f5b59632c4a935d1f7545375c792050a"
  },
  {
    "idx": 37,
    "version": "6",
    "when": 1791737600000,
    "tag": "0037_reversible_order_steps",
    "hash": "8e41445c2291739c17ba5352a3580b0c7fcc12200c34e5a008145aa797b0c2ff"
  },
  {
    "idx": 38,
    "version": "6",
    "when": 1791824000000,
    "tag": "0038_uncollected_products",
    "hash": "6d900d0709877c86e16d5120812f3b93978eb10e51672f778c04e38f333dcd7a"
  },
  {
    "idx": 39,
    "version": "6",
    "when": 1791910400000,
    "tag": "0039_chief_lord_hawal",
    "hash": "8a48e67f5a210cbf9fab88eda4274787cc61b8578bdd93998c237188772d8f84"
  },
  {
    "idx": 40,
    "version": "6",
    "when": 1791996800000,
    "tag": "0040_uncollected_order_resume",
    "hash": "9d190f90a1e8140a5001c90bf379cb01679a8b541e2a9ec65ef45d176bc9a519"
  },
  {
    "idx": 41,
    "version": "6",
    "when": 1792083200000,
    "tag": "0041_bizarre_black_bolt",
    "hash": "081b3c00c45e4703da763fb864027b9deccc373a5a156ece691d129382f73ad6"
  },
  {
    "idx": 42,
    "version": "6",
    "when": 1792169600000,
    "tag": "0042_omniscient_night_thrasher",
    "hash": "18b90f3b3fec4c0dca274ec0688e23e46d5ab13f6ad9c8e35cdcd31c1f3a8375"
  },
  {
    "idx": 43,
    "version": "6",
    "when": 1792256000000,
    "tag": "0043_db05_financial_command_requests",
    "hash": "caed544b1009eee4b9e0cecd0a7691f0361ed60d9537ed24db9843a7cd40c7e0"
  },
  {
    "idx": 44,
    "version": "6",
    "when": 1792342400000,
    "tag": "0044_db06_expense_integer_guards",
    "hash": "c7fc0b32be9639ab5f935c00d293f52d7347e52da871ca80fcdf2f8b9d4cb418"
  },
  {
    "idx": 45,
    "version": "6",
    "when": 1792428800000,
    "tag": "0045_db10_delivery_release_index",
    "hash": "68996ce0ff203be75862deb3ac46d800a200213abdd7a290221c306cde221846"
  },
  {
    "idx": 46,
    "version": "6",
    "when": 1792515200000,
    "tag": "0046_db13_cash_mirror_ref_index",
    "hash": "d570092b26f58bb53383252690ebbeb0ce06fdb29e55c69842e2f92360c05ddc"
  },
  {
    "idx": 47,
    "version": "6",
    "when": 1792601600000,
    "tag": "0047_db16_cash_balance_covering_index",
    "hash": "4fe633a014b7f0b38a2ec1566a26a533e034c816f492f9302169c7916078a7ae"
  },
  {
    "idx": 48,
    "version": "6",
    "when": 1792688000000,
    "tag": "0048_db17_remove_redundant_invoice_terms_index",
    "hash": "9e4ec82ea0096d3948676bb9cd446fdec0f6fb4e2ddcb993efc792c1c58dc676"
  },
  {
    "idx": 49,
    "version": "6",
    "when": 1792774400000,
    "tag": "0049_db06_repository_integer_guards",
    "hash": "3eeb6c711f525a0dd10a5f551ebd6b4bfb3a891035a7aa445c03ab02b04a1734"
  },
  {
    "idx": 50,
    "version": "6",
    "when": 1792860800000,
    "tag": "0050_cc03_username_unique_among_live_users",
    "hash": "2019129596fc53fbbe2649e6e7725bb5d0929bc37b18d16749c0074bfa5c8e8c"
  },
  {
    "idx": 51,
    "version": "6",
    "when": 1792947200000,
    "tag": "0051_cc04_worker_commission_assignment_link",
    "hash": "9ae8fdec6a5086f3b7b92091e93c4ee95a1e8effbe18e46290e88a94d3315e8f"
  },
  {
    "idx": 52,
    "version": "6",
    "when": 1793033600000,
    "tag": "0052_bl03_uncollected_resale_preparation_cost",
    "hash": "1972520b7572ecf6580aba534f1c0daaf5836427713f01df59f9e425a564d9a7"
  }
] as const

export const OLDEST_SUPPORTED_MIGRATION_INDEX = 0
export const CURRENT_MIGRATION_INDEX = 52
export const CURRENT_MIGRATION_CREATED_AT = 1793033600000
