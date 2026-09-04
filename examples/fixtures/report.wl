# Captured from a real model response. Fixtures like this are what CI checks.
#
# Note the order: the root component is declared, then claimed with `r`, then
# everything else. Nothing can paint until `r` arrives, so emitting it second
# means the surface appears immediately and fills in as the rest streams.
c page Stack gap=4
r page
> page title summary metrics table actions
c title Heading text="Q3 revenue by region" level=1
c summary Text value="Revenue grew 12.4% against a flat market, carried by the West region."
c metrics Stack direction=horizontal gap=3
> metrics m_rev m_deals
c m_rev Metric label="Total revenue" value=4820000 unit=USD delta=12.4
c m_deals Metric label="Closed deals" value=184 delta=-3.1
c table Table caption="Revenue and change by region, Q3" columns=["Region","Revenue","Change %"] rows=[["West",1840000,8.2],["East",1520000,-3.1],["Central",1460000,21.7]]
c actions Stack direction=horizontal gap=2
> actions export send
c export Button label="Download as CSV" action=export_csv variant=secondary
c send Button label="Email this report" action=send_report variant=primary
