frappe.ui.form.on('BOM', {

    item(frm) {

        if (!frm.doc.item) return;

        frappe.call({
            method: 'frappe.client.get_value',
            args: {
                doctype: 'Item',
                filters: {
                    name: frm.doc.item
                },
                fieldname: [
                    'custom_die_no_1',
                    'custom_die_no_2',
                    'custom_die_no_3',
                    'custom_die_no_4',
                    'custom_die_no_5',
                    'custom_die_no_6',
                    'custom_die_no7',
                    'custom_die_no_8'
                ]
            },

            callback: function(r) {

                if (!r.exc && r.message) {

                    // clear child table
                    frm.clear_table("custom_die_used_in_bom");

                    let data = r.message;

                    Object.keys(data).forEach(field => {

                        if (data[field]) {

                            let row = frm.add_child("custom_die_used_in_bom");

                            row.die = data[field];
                        }
                    });

                    frm.refresh_field("custom_die_used_in_bom");
                }
            }
        });
    }
});